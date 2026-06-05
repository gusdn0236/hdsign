package com.example.backend.controller;

import com.example.backend.autoquote.vision.VisionApiException;
import com.example.backend.autoquote.vision.VisionProxyService;
import com.example.backend.autoquote.vision.VisionReadTextLimiter;
import com.example.backend.autoquote.vision.VisionRequest;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * @slice-2 자동견적 비전 프록시.
 *
 * <p>{@code POST /api/admin/autoquote/vision} — 브라우저가 보낸 작업지시서 이미지를 받아
 * 서버에서 Claude(forced tool-use)로 보내 구조화 라인아이템(rich schema)을 돌려준다.
 * ANTHROPIC_API_KEY 는 서버 env 에만 있고 응답/로그로 절대 새지 않는다(IRON LAW).
 *
 * <p>인가: 클래스 전체가 {@code /api/admin/**} 아래라 SecurityConfig 가 ROLE_ADMIN 을 요구하고,
 * {@link PreAuthorize} 로 한 번 더 못 박는다(기존 {@link AdminAutoQuoteController} 와 동일 메커니즘).
 * JWT 없으면 401, 비-admin JWT 면 403.
 *
 * <p>본문은 {@code byte[]} 로 받아 컨트롤러-로컬 ObjectMapper 로 파싱한다 — 이렇게 하면
 * Jackson 의 기본 maxStringLength(20MB) 한도를 전역으로 건드리지 않고도(=순수 추가) 80MB 급
 * base64 이미지를 받을 수 있다. 리질리언스(504/429/502/422)는 {@link VisionProxyService} 가,
 * 입력 검증(크기/포맷 400)과 오류 본문 {@code {error, retryable?}} 직렬화는 여기서 담당한다.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
public class AutoQuoteVisionController {

    /** 허용 미디어 타입(스펙: png/jpeg/webp). */
    private static final Set<String> ALLOWED_MEDIA = Set.of("png", "jpeg", "webp");

    /** 디코딩된 이미지 상한(기본 80MB). 테스트는 작은 값으로 덮어 400 경로를 싸게 검증한다. */
    private final long maxBytes;
    private final VisionProxyService service;
    /** 글자읽기(read_text) 일일 호출 한도. 전체추출(report_work_order)엔 적용 안 함. */
    private final VisionReadTextLimiter readTextLimiter;

    /** 큰 base64 본문을 받기 위해 maxStringLength 를 올린 컨트롤러-로컬 매퍼(전역 설정 불변). */
    private final ObjectMapper mapper;

    public AutoQuoteVisionController(
            VisionProxyService service,
            VisionReadTextLimiter readTextLimiter,
            @org.springframework.beans.factory.annotation.Value("${autoquote.vision.max-bytes:83886080}") long maxBytes) {
        this.service = service;
        this.readTextLimiter = readTextLimiter;
        this.maxBytes = maxBytes;
        // 80MB 이미지의 base64 는 ~107MB 문자열 → 기본 20MB 한도 초과. 256MB 로 넉넉히.
        this.mapper = new ObjectMapper();
        this.mapper.getFactory().setStreamReadConstraints(
                StreamReadConstraints.builder().maxStringLength(256 * 1024 * 1024).build());
    }

    /** 스펙 기본 디코딩 상한(기본 80MB)을 운영 빈이 그대로 보유하는지 검증용 접근자. */
    long maxBytes() {
        return maxBytes;
    }

    @PostMapping("/vision")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> vision(@RequestBody(required = false) byte[] body) {
        if (body == null || body.length == 0) {
            return error(HttpStatus.BAD_REQUEST, "missing_image", null);
        }

        VisionRequest req;
        try {
            req = mapper.readValue(body, VisionRequest.class);
        } catch (Exception e) {
            return error(HttpStatus.BAD_REQUEST, "invalid_request", null);
        }
        if (req == null || req.imageBase64() == null || req.imageBase64().isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "missing_image", null);
        }

        // 데이터 URI 접두사("data:image/png;base64,...") 가 있으면 떼어낸다.
        String base64 = stripDataUri(req.imageBase64());

        // 미디어 타입 정규화 + 비-이미지 거부(400).
        String mediaType = normalizeMediaType(req.mediaType());
        if (mediaType == null) {
            return error(HttpStatus.BAD_REQUEST, "unsupported_media_type", null);
        }

        // 크기 상한: 디코드 전 길이로 싸게 추정해 oversize 를 먼저 거른다(80MB 디코드 회피).
        if (estimatedDecodedBytes(base64) > maxBytes) {
            return error(HttpStatus.BAD_REQUEST, "image_too_large", null);
        }

        // base64 유효성 확인(상한 이내일 때만 디코드). 깨진 입력 → 400.
        long decodedLen;
        try {
            decodedLen = Base64.getDecoder().decode(base64).length;
        } catch (IllegalArgumentException e) {
            return error(HttpStatus.BAD_REQUEST, "invalid_image", null);
        }
        if (decodedLen == 0) {
            return error(HttpStatus.BAD_REQUEST, "invalid_image", null);
        }
        if (decodedLen > maxBytes) {
            return error(HttpStatus.BAD_REQUEST, "image_too_large", null);
        }

        // 글자읽기(read_text) 만 일일 한도 적용 — 전체추출(report_work_order)은 무제한.
        boolean isReadText = req.hints() != null
                && "read_text".equals(String.valueOf(req.hints().get("mode")));
        if (isReadText && readTextLimiter.atLimit()) {
            Map<String, Object> limitBody = new LinkedHashMap<>();
            limitBody.put("error", "daily_limit");
            limitBody.put("limit", readTextLimiter.limit());
            limitBody.put("used", readTextLimiter.used());
            limitBody.put("remaining", 0);
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).body(limitBody);
        }

        try {
            Map<String, Object> extracted = service.extract(base64, mediaType, req.hints());
            if (isReadText) {
                readTextLimiter.consume();  // 성공한 호출만 카운트
                Map<String, Object> out = new LinkedHashMap<>(extracted);
                out.put("quota", quotaMap());
                return ResponseEntity.ok(out);
            }
            return ResponseEntity.ok(extracted);
        } catch (VisionApiException e) {
            return error(e.status(), e.errorCode(), e.retryable());
        }
    }

    /** 글자읽기 일일 한도 현황 — 프론트가 '오늘 남은 횟수' 표시·사전 차단에 쓴다. */
    @GetMapping("/vision/quota")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> visionQuota() {
        return ResponseEntity.ok(quotaMap());
    }

    private Map<String, Object> quotaMap() {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("used", readTextLimiter.used());
        q.put("remaining", readTextLimiter.remaining());
        q.put("limit", readTextLimiter.limit());
        return q;
    }

    private static ResponseEntity<Map<String, Object>> error(HttpStatus status, String code, Boolean retryable) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        if (retryable != null) {
            body.put("retryable", retryable);
        }
        return ResponseEntity.status(status).body(body);
    }

    private static String stripDataUri(String s) {
        int comma = s.indexOf(',');
        if (s.startsWith("data:") && comma > 0) {
            return s.substring(comma + 1);
        }
        return s;
    }

    /** null 반환 = 허용되지 않는(비-이미지) 타입. 생략 시 png 기본. */
    private static String normalizeMediaType(String raw) {
        if (raw == null || raw.isBlank()) {
            return "png";
        }
        String m = raw.trim().toLowerCase();
        if (m.startsWith("image/")) {
            m = m.substring("image/".length());
        }
        if (m.equals("jpg")) {
            m = "jpeg";
        }
        return ALLOWED_MEDIA.contains(m) ? m : null;
    }

    /** base64 길이 → 디코딩 바이트 추정(패딩 보정). */
    private static long estimatedDecodedBytes(String base64) {
        long len = base64.length();
        if (len == 0) {
            return 0;
        }
        int padding = 0;
        if (base64.endsWith("==")) {
            padding = 2;
        } else if (base64.endsWith("=")) {
            padding = 1;
        }
        return (len / 4) * 3 - padding;
    }
}
