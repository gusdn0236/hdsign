package com.example.backend.controller;

import com.example.backend.autoquote.vision.VisionClient;
import com.example.backend.autoquote.vision.VisionClientException;
import com.example.backend.security.JwtUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * @slice-2 비전 프록시의 관찰 가능한 동작 검증.
 *
 * 풀 컨텍스트({@code @SpringBootTest})를 띄워 실제 SecurityFilterChain·JwtFilter·컨트롤러를 거친다.
 * Anthropic 클라이언트({@link VisionClient})는 {@link MockBean} 으로 stub — CI 에 실 API 키가 없어도
 * 리질리언스 정책(504/429/502/422)과 매핑을 전부 검증할 수 있다(실 호출 없음).
 *
 * 백오프/타임아웃 예산은 {@link TestPropertySource} 로 작게 덮어 테스트를 빠르고 결정적으로 만든다.
 * max-bytes 도 2KB 로 낮춰 oversize(400) 경로를 큰 페이로드 없이 검증한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("autoquote-it")
@TestPropertySource(properties = {
        "autoquote.vision.timeout-ms=1000",
        "autoquote.vision.rate-limit-backoff-ms=5,5",
        "autoquote.vision.upstream-backoff-ms=5",
        "autoquote.vision.max-bytes=2048",
        // env 로 들어온 키가 응답 본문으로 새지 않는지 검증하기 위한 센티넬.
        "autoquote.vision.api-key=sk-test-LEAK-SENTINEL-MUST-NOT-ECHO"
})
class AutoQuoteVisionControllerTest {

    private static final String VISION_URL = "/api/admin/autoquote/vision";
    private static final String KEY_SENTINEL = "sk-test-LEAK-SENTINEL-MUST-NOT-ECHO";

    /** 정상 추출이 돌려주는 rich-schema 라인아이템(스텁). */
    private static final Map<String, Object> MOCK_EXTRACTION = Map.of(
            "client", "현대사인",
            "contact", "010-1234-5678",
            "order_date", "2026-06-01",
            "due_date", "2026-06-10",
            "sign_types", List.of("채널", "후렉스"),
            "materials", List.of("아크릴", "LED"),
            "dimensions", List.of(Map.of("w", 1200, "h", 600, "coats", 2), Map.of("w", 900, "h", 300)),
            "brand_text", "맛있는 분식",
            "qty", List.of(1, 2),
            "notes", "야간 점등 확인");

    /** 작지만 유효한 base64(미디어=png), 디코딩 < 2KB. */
    private static final String SMALL_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    @MockBean
    private VisionClient visionClient;

    private final ObjectMapper json = new ObjectMapper();

    // ---- helpers ---------------------------------------------------------

    private HttpHeaders adminHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return h;
    }

    private HttpEntity<String> adminBody(String imageB64, String mediaType) {
        String body = "{\"imageBase64\":\"" + imageB64 + "\""
                + (mediaType == null ? "" : ",\"mediaType\":\"" + mediaType + "\"")
                + "}";
        return new HttpEntity<>(body, adminHeaders());
    }

    private ResponseEntity<String> postAsAdmin(String imageB64, String mediaType) {
        return rest.exchange(VISION_URL, HttpMethod.POST, adminBody(imageB64, mediaType), String.class);
    }

    // ---- happy path ------------------------------------------------------

    @Test
    void vision_returns200_withRichSchemaShape() throws Exception {
        when(visionClient.extract(any(), any(), any())).thenReturn(MOCK_EXTRACTION);

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = json.readTree(res.getBody());
        // rich schema (레거시 4-필드를 대체) 의 핵심 키/모양 확인.
        assertThat(body.get("client").asText()).isEqualTo("현대사인");
        assertThat(body.get("sign_types").isArray()).isTrue();
        assertThat(body.get("sign_types")).isNotEmpty();
        assertThat(body.get("materials").isArray()).isTrue();
        assertThat(body.get("dimensions").isArray()).isTrue();
        JsonNode dim0 = body.get("dimensions").get(0);
        assertThat(dim0.has("w")).isTrue();
        assertThat(dim0.has("h")).isTrue();
        assertThat(body.get("qty").isArray()).isTrue();
        assertThat(body.has("brand_text")).isTrue();
        assertThat(body.has("notes")).isTrue();
    }

    @Test
    void vision_stripsDataUriPrefix_andStillSucceeds() throws Exception {
        when(visionClient.extract(any(), any(), any())).thenReturn(MOCK_EXTRACTION);

        ResponseEntity<String> res = postAsAdmin("data:image/png;base64," + SMALL_IMAGE_B64, "png");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ---- media types: jpeg/webp positive (png positive/gif negative 보완) -----

    @Test
    void vision_jpegMediaType_accepted_andNormalizedToJpeg() throws Exception {
        when(visionClient.extract(any(), any(), any())).thenReturn(MOCK_EXTRACTION);
        org.mockito.ArgumentCaptor<String> media = org.mockito.ArgumentCaptor.forClass(String.class);

        // image/jpg → 정규화 jpeg 로 받아들여 200.
        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "image/jpg");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        verify(visionClient).extract(any(), media.capture(), any());
        assertThat(media.getValue()).isEqualTo("jpeg");
    }

    @Test
    void vision_webpMediaType_accepted_andNormalizedToWebp() throws Exception {
        when(visionClient.extract(any(), any(), any())).thenReturn(MOCK_EXTRACTION);
        org.mockito.ArgumentCaptor<String> media = org.mockito.ArgumentCaptor.forClass(String.class);

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "webp");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        verify(visionClient).extract(any(), media.capture(), any());
        assertThat(media.getValue()).isEqualTo("webp");
    }

    // ---- auth ------------------------------------------------------------

    @Test
    void vision_without_jwt_returns401() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> entity = new HttpEntity<>(
                "{\"imageBase64\":\"" + SMALL_IMAGE_B64 + "\"}", h);
        ResponseEntity<String> res = rest.exchange(VISION_URL, HttpMethod.POST, entity, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void vision_with_nonAdmin_jwt_returns403() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        HttpEntity<String> entity = new HttpEntity<>(
                "{\"imageBase64\":\"" + SMALL_IMAGE_B64 + "\"}", h);
        ResponseEntity<String> res = rest.exchange(VISION_URL, HttpMethod.POST, entity, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- input validation (400) -----------------------------------------

    @Test
    void vision_oversizeImage_returns400() {
        // 디코딩 ~3KB > max-bytes(2KB) → image_too_large, 서비스 호출 없이 거부.
        String big = "A".repeat(4000); // valid base64, decodes to 3000 bytes
        ResponseEntity<String> res = postAsAdmin(big, "png");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("\"error\"").contains("image_too_large");
        Mockito.verifyNoInteractions(visionClient);
    }

    @Test
    void vision_nonImageMediaType_returns400() {
        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "gif");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("unsupported_media_type");
        Mockito.verifyNoInteractions(visionClient);
    }

    @Test
    void vision_missingImage_returns400() {
        HttpEntity<String> entity = new HttpEntity<>("{\"mediaType\":\"png\"}", adminHeaders());
        ResponseEntity<String> res = rest.exchange(VISION_URL, HttpMethod.POST, entity, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("missing_image");
    }

    // ---- resilience mappings (stubbed upstream failures) -----------------

    @Test
    void vision_timeout_returns504_withExactErrorBodyAndNoRetryable() throws Exception {
        // 업스트림 예산(1s) 초과 → 504 vision_timeout.
        when(visionClient.extract(any(), any(), any())).thenAnswer(inv -> {
            Thread.sleep(3000);
            return MOCK_EXTRACTION;
        });
        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT);
        // {error, retryable?} 계약을 JSON 파싱으로 정확히 검증(429 테스트와 동일 엄격도, String.contains 아님).
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("vision_timeout");
        assertThat(body.has("retryable")).isFalse(); // 타임아웃은 retryable 필드 없음
    }

    @Test
    void vision_rateLimited_retriesTwice_then429Busy() throws Exception {
        when(visionClient.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.RateLimited("429", null));

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");

        // 상태/본문 매핑만 검증한다. 정확한 재시도 "횟수" 는 VisionProxyServiceTest 가 (HTTP 왕복의
        // POST 재시도 잡음 없이) 결정적으로 검증한다.
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("vision_busy");
        assertThat(body.get("retryable").asBoolean()).isTrue();
    }

    @Test
    void vision_rateLimited_thenSucceeds_returns200() throws Exception {
        when(visionClient.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.RateLimited("429", null))
                .thenReturn(MOCK_EXTRACTION);

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void vision_upstreamError_retriesOnce_then502_withExactErrorBodyAndNoRetryable() throws Exception {
        when(visionClient.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.Upstream("5xx", null));

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("vision_upstream");
        assertThat(body.has("retryable")).isFalse(); // 502 는 retryable 필드 없음
    }

    @Test
    void vision_unparsable_reasksOnce_then422_withExactErrorBodyAndNoRetryable() throws Exception {
        when(visionClient.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.Unparsable("bad tool output", null));

        ResponseEntity<String> res = postAsAdmin(SMALL_IMAGE_B64, "png");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("vision_unparsable");
        assertThat(body.has("retryable")).isFalse(); // 422 는 retryable 필드 없음
    }

    // ---- IRON LAW: key never leaks --------------------------------------

    @Test
    void vision_apiKey_neverAppearsInAnyResponse() throws Exception {
        // 성공 응답에도, 오류 응답에도 env 로 설정한 키 센티넬이 들어가면 안 된다.
        when(visionClient.extract(any(), any(), any()))
                .thenReturn(MOCK_EXTRACTION);
        ResponseEntity<String> ok = postAsAdmin(SMALL_IMAGE_B64, "png");
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody()).doesNotContain(KEY_SENTINEL);
        assertThat(ok.toString()).doesNotContain(KEY_SENTINEL);

        Mockito.reset(visionClient);
        when(visionClient.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.Upstream("5xx", null));
        ResponseEntity<String> err = postAsAdmin(SMALL_IMAGE_B64, "png");
        assertThat(err.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(err.getBody()).doesNotContain(KEY_SENTINEL);
    }
}
