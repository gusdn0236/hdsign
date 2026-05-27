package com.example.backend.service;

import com.google.api.client.googleapis.javanet.GoogleNetHttpTransport;
import com.google.api.client.http.ByteArrayContent;
import com.google.api.client.http.HttpResponseException;
import com.google.api.client.http.HttpTransport;
import com.google.api.client.json.gson.GsonFactory;
import com.google.auth.http.HttpCredentialsAdapter;
import com.google.auth.oauth2.UserCredentials;
import com.google.api.services.drive.Drive;
import com.google.api.services.drive.DriveScopes;
import com.google.api.services.drive.model.File;
import com.google.api.services.drive.model.FileList;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 작업증거 사진을 공용 구글 드라이브에 백업.
 *
 * <p>구조: 루트 폴더({@code HD사인_작업증거}) 하나에 평탄하게 저장.
 * <br>파일명 자동 prefix: <code>{YYYY-MM-DD}_{거래처}_{주문번호}_{원본명}</code>
 * <br>드라이브 검색/정렬을 위한 단일 폴더 정책 — 거래처/주문 분류는 R2 + DB 메타데이터로.
 *
 * <p>실패는 절대 호출자(=evidence 업로드 응답)를 막지 않는다. 모든 예외는 로그만.
 *
 * <p>인증: OAuth 데스크톱 클라이언트 + 일회성 refresh token (scripts/gdrive_get_refresh_token.py).
 * 스코프 drive.file — 이 앱이 만든 파일/폴더만 접근.
 */
@Slf4j
@Service
public class GoogleDriveBackupService {

    @Value("${gdrive.enabled:false}")
    private boolean enabled;

    @Value("${gdrive.client-id:}")
    private String clientId;

    @Value("${gdrive.client-secret:}")
    private String clientSecret;

    @Value("${gdrive.refresh-token:}")
    private String refreshToken;

    @Value("${gdrive.root-folder-name:HD사인_작업증거}")
    private String rootFolderName;

    private static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    private static final DateTimeFormatter YYYY_MM_DD = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    private volatile Drive drive;
    private volatile String rootFolderId;

    // Drive 저장용량 캐시 — about.get 호출은 가볍지만 사용자가 새로고침 연타해도 부담 없게 60초 캐시.
    private static final Duration USAGE_CACHE_TTL = Duration.ofSeconds(60);
    private volatile Instant usageCachedAt;
    private volatile Map<String, Object> cachedUsage;

    @PostConstruct
    void init() {
        if (!enabled) {
            log.info("Google Drive 백업 비활성화 (gdrive.enabled=false)");
            return;
        }
        if (clientId.isBlank() || clientSecret.isBlank() || refreshToken.isBlank()) {
            log.warn("Google Drive 백업 활성화됐으나 자격증명 누락 — 비활성화로 대체");
            enabled = false;
            return;
        }
        log.info("Google Drive 백업 활성화 — 루트 폴더='{}'", rootFolderName);
    }

    /**
     * 사진 1장을 백업. 비동기 — 호출자는 즉시 리턴.
     *
     * <p>호출자는 반드시 트랜잭션이 살아있는 상태에서 거래처명을 미리 추출해 넘겨야 한다.
     * Entity(Order/Client)를 그대로 받으면 @Async 별도 스레드에서 lazy proxy 접근 시
     * "no session" 에러가 발생한다.
     *
     * @param orderNumber  주문번호(파일명 prefix + 로그용)
     * @param companyName  거래처명(파일명 prefix용, 비어있으면 "거래처미상")
     * @param fileName     원본 파일명(중복 시 드라이브가 자동 보정)
     * @param contentType  image/jpeg 등
     * @param data         바이트
     */
    @Async
    public void uploadEvidenceAsync(String orderNumber, String companyName,
                                    String fileName, String contentType, byte[] data) {
        if (!enabled || data == null || data.length == 0) return;
        try {
            Drive d = ensureDrive();
            String rootId = ensureRootFolder(d);

            File metadata = new File()
                    .setName(buildPrefixedFileName(orderNumber, companyName, fileName))
                    .setParents(Collections.singletonList(rootId));

            ByteArrayContent content = new ByteArrayContent(
                    contentType != null ? contentType : "image/jpeg", data);

            File created = d.files().create(metadata, content)
                    .setFields("id,name")
                    .execute();
            log.info("Drive 백업 완료 [{}/{}] -> {}",
                    orderNumber, created.getName(), created.getId());
        } catch (Exception e) {
            String detail = extractHttpErrorDetail(e);
            log.warn("Drive 백업 실패 [{}/{}]: {}{}",
                    orderNumber, fileName, e.getMessage(),
                    detail.isEmpty() ? "" : " | body=" + detail);
        }
    }

    // getMessage()는 status line만 주므로, 진짜 원인이 담긴 응답 본문(예: invalid_grant)을 별도로 꺼낸다.
    private String extractHttpErrorDetail(Throwable e) {
        Throwable cur = e;
        while (cur != null) {
            if (cur instanceof HttpResponseException hre) {
                String body = hre.getContent();
                return body == null ? "" : body.replaceAll("\\s+", " ").trim();
            }
            cur = cur.getCause();
        }
        return "";
    }

    private Drive ensureDrive() throws Exception {
        Drive local = drive;
        if (local != null) return local;
        synchronized (this) {
            if (drive != null) return drive;
            HttpTransport transport = GoogleNetHttpTransport.newTrustedTransport();
            UserCredentials creds = UserCredentials.newBuilder()
                    .setClientId(clientId)
                    .setClientSecret(clientSecret)
                    .setRefreshToken(refreshToken)
                    .build();
            // drive.file 스코프는 UserCredentials 자체엔 안 박지만, OAuth client 가 동의받은 스코프가
            // 토큰에 따라옴. 빌드시 명시는 가독성용.
            creds.getRequestMetadata(); // refresh token → access token 워밍업
            drive = new Drive.Builder(
                    transport,
                    GsonFactory.getDefaultInstance(),
                    new HttpCredentialsAdapter(creds.createScoped(List.of(DriveScopes.DRIVE_FILE))))
                    .setApplicationName("HDSign Backup")
                    .build();
            return drive;
        }
    }

    /**
     * 구글 드라이브 저장용량 — about.get 의 storageQuota 필드.
     * 결과 키: enabled, limit, usage, usageInDrive, usageInDriveTrash, percent, unlimited.
     * limit==null 이면 Workspace unlimited 계정 — 그땐 percent 0, unlimited=true.
     */
    public Map<String, Object> getStorageUsage() {
        if (!enabled) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("enabled", false);
            return m;
        }
        Instant at = usageCachedAt;
        Map<String, Object> cached = cachedUsage;
        if (at != null && cached != null && Duration.between(at, Instant.now()).compareTo(USAGE_CACHE_TTL) < 0) {
            return cached;
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("enabled", true);
        try {
            Drive d = ensureDrive();
            com.google.api.services.drive.model.About about = d.about().get()
                    .setFields("storageQuota,user(emailAddress,displayName)")
                    .execute();
            com.google.api.services.drive.model.About.StorageQuota q = about.getStorageQuota();
            Long limit = q != null ? q.getLimit() : null;
            Long usage = q != null ? q.getUsage() : null;
            Long inDrive = q != null ? q.getUsageInDrive() : null;
            Long inTrash = q != null ? q.getUsageInDriveTrash() : null;
            boolean unlimited = (limit == null || limit <= 0);
            double percent = unlimited ? 0.0 : 100.0 * (usage == null ? 0 : usage) / (double) limit;
            result.put("limit", limit);
            result.put("usage", usage);
            result.put("usageInDrive", inDrive);
            result.put("usageInDriveTrash", inTrash);
            result.put("unlimited", unlimited);
            result.put("percent", percent);
            result.put("rootFolderName", rootFolderName);
            if (about.getUser() != null) {
                result.put("accountEmail", about.getUser().getEmailAddress());
            }
        } catch (Exception e) {
            String detail = extractHttpErrorDetail(e);
            log.warn("Drive 저장용량 조회 실패: {}{}", e.getMessage(),
                    detail.isEmpty() ? "" : " | body=" + detail);
            result.put("error", e.getMessage() + (detail.isEmpty() ? "" : " | " + detail));
        }
        cachedUsage = result;
        usageCachedAt = Instant.now();
        return result;
    }

    private String ensureRootFolder(Drive d) throws Exception {
        if (rootFolderId != null) return rootFolderId;
        synchronized (this) {
            if (rootFolderId != null) return rootFolderId;
            String existing = findFolder(d, rootFolderName, "root");
            rootFolderId = existing != null ? existing : createFolder(d, rootFolderName, "root");
            return rootFolderId;
        }
    }

    /**
     * 파일명에 자동 prefix 부여: {YYYY-MM-DD}_{거래처}_{주문번호}_{원본명}.
     * 업로드 시점 날짜 기준(현장에서 사진을 찍은 시점) — 주문 생성일과 다를 수 있음.
     * 길이가 너무 길어지면 원본명을 뒷쪽에서 잘라 200자 이내로 맞춤.
     */
    private String buildPrefixedFileName(String orderNumber, String companyName, String originalName) {
        String date = YYYY_MM_DD.format(LocalDateTime.now());
        String company = (companyName == null || companyName.isBlank()) ? "거래처미상" : companyName;
        String safeCompany = sanitizeForFileName(company);

        String safeOrderNumber = (orderNumber == null || orderNumber.isBlank()) ? "주문번호없음" : orderNumber;
        String safeOrder = sanitizeForFileName(safeOrderNumber);

        String prefix = date + "_" + safeCompany + "_" + safeOrder + "_";
        String body = safeFileName(originalName);
        String combined = prefix + body;
        if (combined.length() > 200) {
            int allowedBody = Math.max(20, 200 - prefix.length());
            int dot = body.lastIndexOf('.');
            String ext = (dot > 0 && body.length() - dot <= 8) ? body.substring(dot) : "";
            String stem = ext.isEmpty() ? body : body.substring(0, dot);
            int stemBudget = allowedBody - ext.length();
            if (stemBudget < 1) stemBudget = 1;
            String trimmed = stem.length() > stemBudget ? stem.substring(0, stemBudget) : stem;
            combined = prefix + trimmed + ext;
        }
        return combined;
    }

    private String sanitizeForFileName(String name) {
        if (name == null) return "";
        String s = name.trim()
                .replace('/', '_').replace('\\', '_')
                .replace(':', '_').replace('*', '_')
                .replace('?', '_').replace('"', '_')
                .replace('<', '_').replace('>', '_')
                .replace('|', '_');
        return s.isEmpty() ? "_" : s;
    }

    private String findFolder(Drive d, String name, String parentId) throws Exception {
        // name 안의 ' 는 \\' 로 이스케이프 — Drive query 문법.
        String safeName = name.replace("\\", "\\\\").replace("'", "\\'");
        String q = "mimeType='" + FOLDER_MIME + "'"
                + " and trashed=false"
                + " and '" + parentId + "' in parents"
                + " and name='" + safeName + "'";
        FileList result = d.files().list()
                .setQ(q)
                .setSpaces("drive")
                .setFields("files(id,name)")
                .setPageSize(1)
                .execute();
        List<File> files = result.getFiles();
        return (files != null && !files.isEmpty()) ? files.get(0).getId() : null;
    }

    private String createFolder(Drive d, String name, String parentId) throws Exception {
        File metadata = new File()
                .setName(name)
                .setMimeType(FOLDER_MIME)
                .setParents(Collections.singletonList(parentId));
        File created = d.files().create(metadata).setFields("id").execute();
        return created.getId();
    }

    private String safeFileName(String name) {
        if (name == null || name.isBlank()) return "evidence.jpg";
        String s = name.replace('/', '_').replace('\\', '_').trim();
        if (s.length() > 200) {
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && s.length() - dot <= 8) ? s.substring(dot) : "";
            s = s.substring(0, 200 - ext.length()) + ext;
        }
        return s;
    }
}
