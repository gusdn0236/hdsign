package com.example.backend.controller;

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
 * 런타임 파일시스템 디렉터리({@code autoquote.data-dir}, env {@code AUTOQUOTE_DATA_DIR})에서
 * {@link java.nio.file.Files}로 읽는다. 로컬은 {@code auto-quote-data/autoquote}(gitignore),
 * 운영은 Railway 볼륨을 {@code AUTOQUOTE_DATA_DIR}로 마운트한다. 프론트/엔진은 그대로
 * {@code GET /api/admin/autoquote/{corpus,priors}} 를 호출한다(계약 불변).
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
     * 기밀 데이터 홈. 로컬: {@code auto-quote-data/autoquote}, 운영: Railway 볼륨 마운트 경로.
     * 미설정이면 503(절대 classpath fallback 없음 — 유출 방지).
     */
    @Value("${autoquote.data-dir:}")
    private String dataDir;

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
     * 런타임 데이터 홈에서 파일을 읽는다. 디렉터리 미설정/부재이거나 파일이 없거나 읽기 실패면
     * {@code null} 을 돌려 호출부가 503 으로 graceful 처리하게 한다(예외/500 없음).
     */
    private Cached tryLoad(String name) {
        if (dataDir == null || dataDir.isBlank()) {
            return null;
        }
        Path p = Paths.get(dataDir, name).toAbsolutePath().normalize();
        if (!Files.isReadable(p) || Files.isDirectory(p)) {
            return null;
        }
        try {
            byte[] body = Files.readAllBytes(p);
            return new Cached(body, '"' + sha256Hex(body) + '"');
        } catch (IOException e) {
            // 읽기 중 IO 오류도 기밀 누수/500 대신 graceful 503 으로.
            return null;
        }
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
