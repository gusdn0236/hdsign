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
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 기밀 데이터가 어느 소스에도 프로비저닝되지 않은 경우의 graceful 동작 검증(slice-6: 둘 다 없음):
 *  - {@code autoquote.data-dir} 가 존재하지 않는 디렉터리를 가리키고 {@code r2.bucket} 도 비어 있으면
 *    corpus/priors 는 500/stacktrace 가 아니라 <b>503 {"error":"autoquote_data_unavailable"}</b> 로 응답한다.
 *  - admin JWT 인증은 여전히 통과해야 503 에 도달한다(인증 자체는 깨지지 않음).
 *
 * 실데이터는 절대 참조하지 않는다 — 일부러 빈/부재 경로 + 빈 버킷을 둔다(R2 네트워크 호출 없음).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuoteUnavailableTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    private final ObjectMapper json = new ObjectMapper();

    /** 존재하지 않는 디렉터리 + 빈 버킷 → 두 소스 모두 미프로비저닝(네트워크 호출 없음). */
    @DynamicPropertySource
    static void noSourceAvailable(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir",
                () -> "build/__autoquote_missing__/does-not-exist");
        // 빈 버킷 → R2 소스 비활성. (테스트 기본 r2.bucket=local-dummy-bucket 이라 명시적으로 비운다.)
        registry.add("r2.bucket", () -> "");
    }

    private HttpEntity<Void> adminAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return new HttpEntity<>(headers);
    }

    @Test
    void corpus_whenDataMissing_returns503_withErrorBody() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
    }

    @Test
    void priors_whenDataMissing_returns503_withErrorBody() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
    }

    @Test
    void corpus_whenDataMissing_stillRequiresAdminJwt_401() {
        ResponseEntity<String> res = rest.getForEntity(
                "/api/admin/autoquote/corpus", String.class);
        // 데이터가 없어도 인증 게이트가 먼저다 — JWT 없으면 401(503 이 아님).
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
