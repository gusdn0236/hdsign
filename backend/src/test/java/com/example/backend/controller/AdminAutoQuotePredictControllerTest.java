package com.example.backend.controller;

import com.example.backend.security.JwtUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Paths;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 자동견적 가격예측(/predict) + 근거(/evidence) 엔드포인트의 관찰 가능한 동작 검증.
 *
 * <p>{@code autoquote.data-dir} 를 {@code src/test/resources/autoquote-fixtures}(작은 가짜
 * priced_index.json·easyform·PNG)로 가리켜 컨트롤러가 런타임 파일시스템에서 읽는 경로를
 * 그대로 검증한다. <b>실제 기밀 코퍼스/명세서/사진은 절대 참조하지 않는다.</b>
 *
 * <p>풀 컨텍스트({@code @SpringBootTest})로 실제 SecurityFilterChain·JwtFilter 를 거친다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuotePredictControllerTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    private final ObjectMapper json = new ObjectMapper();

    @DynamicPropertySource
    static void dataDir(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir", AdminAutoQuotePredictControllerTest::fixtureDir);
    }

    static String fixtureDir() {
        try {
            return Paths.get(AdminAutoQuotePredictControllerTest.class
                            .getResource("/autoquote-fixtures").toURI())
                    .toAbsolutePath().toString();
        } catch (Exception e) {
            throw new IllegalStateException("test fixture dir missing", e);
        }
    }

    private HttpHeaders adminHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private HttpHeaders clientHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private ResponseEntity<String> postPredict(HttpHeaders headers, String body) {
        return rest.exchange("/api/admin/autoquote/predict", HttpMethod.POST,
                new HttpEntity<>(body, headers), String.class);
    }

    // ---- /predict 인가 ------------------------------------------------------

    @Test
    void predict_withoutJwt_returns401() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> res = postPredict(h,
                "{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\",\"size\":\"h:300\"}]}");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void predict_withNonAdminJwt_returns403() {
        ResponseEntity<String> res = postPredict(clientHeaders(),
                "{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\",\"size\":\"h:300\"}]}");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        // 거부 응답이 단가/근거를 흘리지 않았는지도 확인.
        assertThat(res.getBody() == null || !res.getBody().contains("ref_invoice_idx")).isTrue();
    }

    // ---- /predict 동작 ------------------------------------------------------

    @Test
    void predict_clientTier_returns200_withSchema() throws Exception {
        ResponseEntity<String> res = postPredict(adminHeaders(),
                "{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\",\"material\":\"아크릴\",\"size\":\"h:300\",\"qty\":\"1\"}]}");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.isArray()).isTrue();
        assertThat(body).hasSize(1);

        JsonNode p = body.get(0);
        // 응답 스키마: price>0, ref_invoice_idx, reason 존재.
        assertThat(p.get("price").asInt()).isGreaterThan(0);
        assertThat(p.hasNonNull("refInvoiceIdx")).isTrue();
        assertThat(p.get("reason").asText()).isNotBlank();
        assertThat(p.get("src").asText()).isEqualTo("이력");
        assertThat(p.get("refFile").asText()).isEqualTo("easyform_2099_test.json");
        // h:300(=90000) == 이력 사이즈 → 보정 1.0배, 단가 그대로 100000.
        assertThat(p.get("price").asInt()).isEqualTo(100000);
        assertThat(p.get("score").asDouble()).isGreaterThan(0.34);
    }

    @Test
    void predict_globalFallback_whenClientUnknown() throws Exception {
        // byClient 에 없는 거래처 → tier ② 전체 동일품목.
        ResponseEntity<String> res = postPredict(adminHeaders(),
                "{\"client\":\"처음보는거래처\",\"items\":[{\"text\":\"후렉스배너\",\"size\":\"1000x500\"}]}");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode p = json.readTree(res.getBody()).get(0);
        assertThat(p.get("src").asText()).isEqualTo("전체");
        assertThat(p.get("price").asInt()).isEqualTo(35000); // 동일 사이즈 → 보정 없음.
        assertThat(p.get("refInvoiceIdx").asInt()).isEqualTo(11);
    }

    @Test
    void predict_sizeScaling_clampedAtTwoX() throws Exception {
        // h:600(=360000) vs 이력 h:300(=90000) → sqrt(4)=2.0 (clamp 상한) → 200000.
        ResponseEntity<String> res = postPredict(adminHeaders(),
                "{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\",\"size\":\"h:600\"}]}");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode p = json.readTree(res.getBody()).get(0);
        assertThat(p.get("price").asInt()).isEqualTo(200000);
        assertThat(p.get("reason").asText()).contains("사이즈보정");
    }

    @Test
    void predict_noMatch_returnsNullPriceWithReason() throws Exception {
        ResponseEntity<String> res = postPredict(adminHeaders(),
                "{\"client\":\"한국사인\",\"items\":[{\"text\":\"존재하지않는희한한품목\"}]}");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode p = json.readTree(res.getBody()).get(0);
        assertThat(p.get("price").isNull()).isTrue();
        assertThat(p.get("reason").asText()).isNotBlank();
    }

    @Test
    void predict_missingItems_returns400() {
        ResponseEntity<String> res = postPredict(adminHeaders(), "{\"client\":\"한국사인\"}");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- /evidence ----------------------------------------------------------

    @Test
    void evidence_withoutJwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void evidence_withNonAdminJwt_returns403() {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(clientHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void evidence_returns200_withGridShape() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("invoiceIdx").asInt()).isEqualTo(10);
        assertThat(body.get("client").asText()).isEqualTo("한국사인");
        assertThat(body.get("grid").isArray()).isTrue();
        assertThat(body.get("grid")).isNotEmpty();
        JsonNode row = body.get("grid").get(0);
        assertThat(row.get("item").asText()).isEqualTo("채널간판");
        assertThat(row.get("unitPrice").asText()).isEqualTo("100000");
    }

    @Test
    void evidence_includesPhoto_whenAvailable() throws Exception {
        // idx 10 에는 easyform_2099_test_10.png 픽스처가 있다.
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("photoAvailable").asBoolean()).isTrue();
        assertThat(body.get("photoContentType").asText()).isEqualTo("image/png");
        assertThat(body.get("photoBase64").asText()).isNotBlank();
    }

    @Test
    void evidence_noPhoto_whenAbsent() throws Exception {
        // idx 11 에는 매칭되는 사진 픽스처가 없다 → grid 는 그대로, 사진만 false.
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/11?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("photoAvailable").asBoolean()).isFalse();
        assertThat(body.get("grid")).isNotEmpty();
    }

    @Test
    void evidence_invalidFile_returns400() {
        // 디렉터리 탈출/비-easyform 파일은 화이트리스트에서 거부.
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=corpus.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void evidence_notFound_returns404() {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/9999?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
