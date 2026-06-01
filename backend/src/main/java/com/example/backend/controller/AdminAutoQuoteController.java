package com.example.backend.controller;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.WebRequest;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 자동견적 탭이 회사 기밀 학습 데이터를 JWT 뒤에서 읽기 위한 admin 전용 엔드포인트.
 *
 * - {@code corpus.json} (4.66MB) — 과거 명세서 라인 코퍼스(정답지). 견적 엔진의 tier ① 매칭 소스.
 * - {@code priors.json}          — 학습된 정적 prior (bridges / reorderPairs / size→price buckets / synthDigest).
 *
 * 두 파일 모두 classpath 리소스({@code /autoquote/})로 번들 — {@link CalcPricesController} 의
 * baseline 패턴과 동일하게 JAR 안에 있어 컨테이너 환경에서도 항상 접근 가능하다.
 * <b>절대 frontend/public 으로 내보내지 않는다</b>(공개 GitHub Pages 로 유출 금지). 프론트는
 * 탭 진입 시 이 엔드포인트를 lazy-fetch 하고 브라우저가 ETag 로 캐시한다.
 *
 * 응답은 내용 해시(SHA-256) 기반 ETag 를 달아 캐시 가능하게 만든다. {@code If-None-Match}
 * 가 일치하면 304 로 본문 없이 응답해 4.66MB 재전송을 피한다. 리소스는 불변이므로
 * 바이트와 ETag 를 프로세스당 한 번만 계산해 캐시한다.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
public class AdminAutoQuoteController {

    private static final String CORPUS_RESOURCE = "autoquote/corpus.json";
    private static final String PRIORS_RESOURCE = "autoquote/priors.json";

    /** 리소스 경로 → (바이트, ETag) 캐시. classpath 리소스는 불변이라 한 번만 읽으면 된다. */
    private final ConcurrentMap<String, Cached> cache = new ConcurrentHashMap<>();

    /** 기밀 코퍼스(과거 명세서 라인). 견적 엔진 tier ① 매칭 소스. */
    @GetMapping("/corpus")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<byte[]> getCorpus(WebRequest request) {
        return serve(CORPUS_RESOURCE, request);
    }

    /** 학습된 정적 prior (bridges / reorderPairs / sizeBuckets / synthDigest). */
    @GetMapping("/priors")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<byte[]> getPriors(WebRequest request) {
        return serve(PRIORS_RESOURCE, request);
    }

    private ResponseEntity<byte[]> serve(String resource, WebRequest request) {
        Cached c = cache.computeIfAbsent(resource, AdminAutoQuoteController::load);

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

    private static Cached load(String resource) {
        try (InputStream in = new ClassPathResource(resource).getInputStream()) {
            byte[] body = in.readAllBytes();
            return new Cached(body, '"' + sha256Hex(body) + '"');
        } catch (IOException e) {
            throw new UncheckedIOException("자동견적 리소스를 읽지 못했습니다: " + resource, e);
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

    /** classpath 리소스의 원본 바이트 + 따옴표 포함 강한 ETag. */
    private static final class Cached {
        final byte[] body;
        final String etag;

        Cached(byte[] body, String etag) {
            this.body = body;
            this.etag = etag;
        }
    }
}
