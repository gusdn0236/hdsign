package com.example.backend.service;

import com.google.api.client.googleapis.javanet.GoogleNetHttpTransport;
import com.google.api.client.http.ByteArrayContent;
import com.google.api.client.http.HttpTransport;
import com.google.api.client.json.gson.GsonFactory;
import com.google.auth.http.HttpCredentialsAdapter;
import com.google.auth.oauth2.UserCredentials;
import com.google.api.services.drive.Drive;
import com.google.api.services.drive.DriveScopes;
import com.google.api.services.drive.model.File;
import com.google.api.services.drive.model.FileList;
import com.example.backend.entity.Order;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 작업증거 사진을 공용 구글 드라이브에 백업.
 *
 * <p>구조: <code>HD사인_작업증거 / {거래처명} / {MM-DD제목} / {파일명}</code>
 * <br>워처가 네트워크 거래처 폴더에 쓰는 명명규칙과 동일 — 일관성 위해.
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
    private static final DateTimeFormatter MM_DD = DateTimeFormatter.ofPattern("MM-dd");

    private volatile Drive drive;
    private volatile String rootFolderId;

    // company 또는 (company|MM-DDtitle) → folderId. 한 번 만든 폴더는 다음 업로드부터 즉시 재사용.
    // 사용자가 드라이브에서 폴더를 옮기거나 휴지통으로 보내면 캐시가 stale 이 됨 — 그땐 업로드가 한 번
    // 실패하고 진단이 어려워지지만, 정상 운영 중엔 발생할 일이 거의 없어 일단 단순 캐시로 둠.
    private final ConcurrentMap<String, String> folderCache = new ConcurrentHashMap<>();

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
     * @param order        주문(거래처/제목/생성일 추출용)
     * @param fileName     원본 파일명(중복 시 드라이브가 자동 보정)
     * @param contentType  image/jpeg 등
     * @param data         바이트
     */
    @Async
    public void uploadEvidenceAsync(Order order, String fileName, String contentType, byte[] data) {
        if (!enabled || data == null || data.length == 0) return;
        try {
            Drive d = ensureDrive();
            String orderFolderId = ensureOrderFolder(d, order);

            File metadata = new File()
                    .setName(safeFileName(fileName))
                    .setParents(Collections.singletonList(orderFolderId));

            ByteArrayContent content = new ByteArrayContent(
                    contentType != null ? contentType : "image/jpeg", data);

            File created = d.files().create(metadata, content)
                    .setFields("id,name")
                    .execute();
            log.info("Drive 백업 완료 [{}/{}] -> {}",
                    order.getOrderNumber(), created.getName(), created.getId());
        } catch (Exception e) {
            log.warn("Drive 백업 실패 [{}/{}]: {}",
                    order.getOrderNumber(), fileName, e.getMessage());
        }
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

    private String ensureRootFolder(Drive d) throws Exception {
        if (rootFolderId != null) return rootFolderId;
        synchronized (this) {
            if (rootFolderId != null) return rootFolderId;
            String existing = findFolder(d, rootFolderName, "root");
            rootFolderId = existing != null ? existing : createFolder(d, rootFolderName, "root");
            return rootFolderId;
        }
    }

    private String ensureOrderFolder(Drive d, Order order) throws Exception {
        String company = order.getClient() != null ? order.getClient().getCompanyName() : null;
        if (company == null || company.isBlank()) company = "거래처미상";
        String safeCompany = sanitizeFolderName(company);

        String companyKey = "C:" + safeCompany;
        String companyId = folderCache.get(companyKey);
        if (companyId == null) {
            String rootId = ensureRootFolder(d);
            companyId = findFolder(d, safeCompany, rootId);
            if (companyId == null) companyId = createFolder(d, safeCompany, rootId);
            folderCache.put(companyKey, companyId);
        }

        // MM-DD제목 — 워처와 동일하게 "공백 없이 결합"
        LocalDateTime created = order.getCreatedAt() != null ? order.getCreatedAt() : LocalDateTime.now();
        String title = order.getTitle() != null ? order.getTitle().trim() : "";
        if (title.isEmpty()) title = "제목없음";
        String dateTitle = sanitizeFolderName(MM_DD.format(created) + title);

        String orderKey = companyKey + "|O:" + dateTitle;
        String orderId = folderCache.get(orderKey);
        if (orderId == null) {
            orderId = findFolder(d, dateTitle, companyId);
            if (orderId == null) orderId = createFolder(d, dateTitle, companyId);
            folderCache.put(orderKey, orderId);
        }
        return orderId;
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

    /** Drive API name 에서 슬래시는 표시는 되지만 검색/표시에서 헷갈리므로 _ 로 치환. */
    private String sanitizeFolderName(String name) {
        String s = name.trim().replace('/', '_').replace('\\', '_');
        if (s.length() > 120) s = s.substring(0, 120);
        return s.isEmpty() ? "_" : s;
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
