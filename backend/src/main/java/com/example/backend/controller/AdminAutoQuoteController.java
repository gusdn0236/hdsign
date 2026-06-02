package com.example.backend.controller;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.WebRequest;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 자동견적 탭이 회사 기밀 학습 데이터를 JWT 뒤에서 읽기 위한 admin 전용 엔드포인트.
 *
 * - {@code corpus.json} (4.66MB) — 과거 명세서 라인 코퍼스(정답지). 견적 엔진의 tier ① 매칭 소스.
 * - {@code priors.json}          — 학습된 정적 prior (bridges / reorderPairs / size→price buckets / synthDigest).
 *
 * <b>Iron Law</b>: corpus/priors 는 회사 기밀이라 공개 GitHub 저장소(이 repo 는 PUBLIC)에 절대
 * 커밋하지 않는다. classpath 리소스로 번들하면 빌드 산출물·git 에 그대로 섞여 유출되므로,
 * 런타임에 두 소스 중 하나에서 읽는다(layered, slice-6):
 * <ol>
 *   <li><b>파일시스템</b> — {@code autoquote.data-dir}(env {@code AUTOQUOTE_DATA_DIR}) 가 설정되어
 *       있고 {@code <dir>/<name>} 이 읽기 가능하면 {@link java.nio.file.Files}로 읽는다.
 *       로컬/통합테스트(e2e)의 기본 경로(예: {@code auto-quote-data/autoquote}, gitignore).</li>
 *   <li><b>Cloudflare R2</b> — data-dir 가 미설정/부재이고 {@code r2.bucket} 이 설정돼 있으면
 *       기존 {@link S3Client} 빈(R2Config)으로 {@code <r2-prefix><name>} 객체를 받아 읽는다.
 *       운영(Railway) 기본 소스: 다른 기능과 같은 {@code R2_*} env 만 있으면 동작.</li>
 *   <li>둘 다 없으면 503 graceful(아래).</li>
 * </ol>
 * 프론트/엔진은 그대로 {@code GET /api/admin/autoquote/{corpus,priors}} 를 호출한다(계약 불변).
 *
 * <b>운영(PROD)</b>: {@code AUTOQUOTE_DATA_DIR} 를 <i>설정하지 않고</i>(→ R2 사용),
 * {@code R2_ACCESS_KEY/R2_SECRET_KEY/R2_ENDPOINT/R2_BUCKET}(이미 다른 기능이 쓰는 값)만 두고
 * {@code corpus.json}·{@code priors.json} 을 버킷의 {@code autoquote/} 프리픽스 아래 업로드한다.
 * <b>로컬/테스트</b>: {@code autoquote.data-dir} 를 {@code auto-quote-data/autoquote} 로 가리킨다
 * (실 R2 자격증명 없이도 동작 — slice-5 동작 보존).
 *
 * 응답은 내용 해시(SHA-256) 기반 강한 ETag 를 달아 캐시 가능하게 만든다. {@code If-None-Match}
 * 가 일치하면 304 로 본문 없이 응답해 4.66MB 재전송을 피한다. 성공적으로 읽은 바이트와 ETag 는
 * 프로세스당 한 번만 계산해 캐시한다(파일은 갱신될 수 있으므로 실패는 캐시하지 않는다).
 *
 * GRACEFUL 실패: 디렉터리가 미설정/부재이거나 파일이 없으면 500/stacktrace 대신 503 +
 * {@code {"error":"autoquote_data_unavailable"}} 로 명확히 응답한다. admin JWT 는 항상 필요하다.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
public class AdminAutoQuoteController {

    private static final String CORPUS_NAME = "corpus.json";
    private static final String PRIORS_NAME = "priors.json";

    /** 503 본문(기밀 데이터 미프로비저닝 시). 스택트레이스 대신 안정된 JSON 계약. */
    private static final Map<String, String> UNAVAILABLE = Map.of("error", "autoquote_data_unavailable");

    /**
     * 기밀 데이터 홈(파일시스템 소스). 로컬/테스트: {@code auto-quote-data/autoquote}.
     * 설정·읽기 가능하면 R2 보다 우선한다. 미설정이면 R2 로 폴백(아래).
     */
    @Value("${autoquote.data-dir:}")
    private String dataDir;

    /** R2 버킷. data-dir 가 없을 때만 사용. 비어 있으면 R2 소스 비활성(→ 503). */
    @Value("${r2.bucket:}")
    private String bucket;

    /** R2 객체 키 프리픽스. {@code autoquote/} 아래에 corpus.json/priors.json 을 둔다. */
    @Value("${autoquote.r2-prefix:autoquote/}")
    private String r2Prefix;

    /**
     * 기존 R2(S3 호환) 클라이언트 빈(R2Config). 다른 기능과 공유. data-dir 폴백 소스로만 쓴다.
     * 자격증명/엔드포인트 미설정이어도 빈은 존재하므로 {@code @Autowired(required=false)} 로 둔다.
     */
    private final S3Client s3Client;

    @Autowired
    public AdminAutoQuoteController(@Autowired(required = false) S3Client s3Client) {
        this.s3Client = s3Client;
    }

    /** 파일명 → (바이트, ETag) 캐시. 성공 로드만 캐시한다(미프로비저닝 파일은 나중에 채워질 수 있으므로). */
    private final ConcurrentMap<String, Cached> cache = new ConcurrentHashMap<>();

    /** 기밀 코퍼스(과거 명세서 라인). 견적 엔진 tier ① 매칭 소스. */
    @GetMapping("/corpus")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> getCorpus(WebRequest request) {
        return serve(CORPUS_NAME, request);
    }

    /** 학습된 정적 prior (bridges / reorderPairs / sizeBuckets / synthDigest). */
    @GetMapping("/priors")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> getPriors(WebRequest request) {
        return serve(PRIORS_NAME, request);
    }

    private ResponseEntity<?> serve(String name, WebRequest request) {
        Cached c = cache.get(name);
        if (c == null) {
            c = tryLoad(name);
            if (c == null) {
                // 디렉터리 미설정/부재 또는 파일 없음 → 503(graceful, 본문에 기밀 없음).
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(UNAVAILABLE);
            }
            cache.put(name, c);
        }

        // ETag 일치 → 304, 본문 생략(대용량 코퍼스 재전송 방지). checkNotModified 는
        // 약/강 ETag 비교와 따옴표 패딩을 알아서 처리한다.
        if (request.checkNotModified(c.etag)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                    .eTag(c.etag)
                    .build();
        }

        return ResponseEntity.ok()
                .eTag(c.etag)
                // 기밀 데이터라 private — 공유 캐시(CDN/프록시)에는 저장 금지, 브라우저만.
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePrivate())
                .contentType(MediaType.APPLICATION_JSON)
                .body(c.body);
    }

    /**
     * 두 소스를 순서대로 시도한다(layered):
     * <ol>
     *   <li>파일시스템({@code autoquote.data-dir}) — 설정·읽기 가능하면 거기서 읽는다(slice-5 경로).</li>
     *   <li>R2({@code r2.bucket} + {@code r2-prefix}) — 위가 안 되고 버킷이 설정돼 있으면 객체를 받는다.</li>
     * </ol>
     * 어느 소스도 사용할 수 없거나 읽기에 실패하면 {@code null} 을 돌려 호출부가 503 으로 graceful
     * 처리하게 한다(예외/500 없음, 미스는 캐시하지 않음).
     */
    private Cached tryLoad(String name) {
        Cached fromFs = tryFilesystem(name);
        if (fromFs != null) {
            return fromFs;
        }
        return tryR2(name);
    }

    /** 파일시스템 소스. data-dir 미설정/부재이거나 파일이 없거나 IO 실패면 {@code null}. */
    private Cached tryFilesystem(String name) {
        if (dataDir == null || dataDir.isBlank()) {
            return null;
        }
        Path p = Paths.get(dataDir, name).toAbsolutePath().normalize();
        if (!Files.isReadable(p) || Files.isDirectory(p)) {
            return null;
        }
        try {
            byte[] body = Files.readAllBytes(p);
            return toCached(body);
        } catch (IOException e) {
            // 읽기 중 IO 오류도 기밀 누수/500 대신 graceful 503 으로.
            return null;
        }
    }

    /**
     * R2 소스. 버킷/클라이언트가 없거나 객체가 없거나(NoSuchKey) S3/SDK 오류·자격증명 누락이면
     * {@code null} 을 돌려 graceful 503 으로 떨어뜨린다. <b>R2 비밀/원본 예외는 로그/응답에 절대
     * 노출하지 않는다.</b>
     */
    private Cached tryR2(String name) {
        if (s3Client == null || bucket == null || bucket.isBlank()) {
            return null;
        }
        String prefix = (r2Prefix == null) ? "" : r2Prefix;
        String key = prefix + name;
        try (ResponseInputStream<GetObjectResponse> in = s3Client.getObject(
                GetObjectRequest.builder().bucket(bucket).key(key).build())) {
            byte[] body = in.readAllBytes();
            return toCached(body);
        } catch (SdkException | IOException e) {
            // NoSuchKeyException·S3Exception·SdkClientException(자격증명/엔드포인트 누락)·읽기 IO 오류
            // 모두 여기로 — 500/스택트레이스/기밀 노출 없이 unavailable 로 처리(미스는 캐시 안 함).
            return null;
        }
    }

    /** 원본 바이트 + 따옴표 포함 SHA-256 강한 ETag 로 캐시 항목을 만든다(소스 무관 동일 계산). */
    private static Cached toCached(byte[] body) {
        return new Cached(body, '"' + sha256Hex(body) + '"');
    }

    private static String sha256Hex(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** 런타임 파일의 원본 바이트 + 따옴표 포함 강한 ETag. */
    private static final class Cached {
        final byte[] body;
        final String etag;

        Cached(byte[] body, String etag) {
            this.body = body;
            this.etag = etag;
        }
    }
}
