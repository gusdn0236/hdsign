package com.example.backend.controller;

import com.example.backend.security.JwtUtil;
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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 기밀 데이터 미프로비저닝(파일시스템·R2 둘 다 없음) 시 graceful 동작:
 *  - {@code POST /predict} → 503 {"error":"autoquote_data_unavailable"} (스택트레이스/500 아님)
 *  - {@code GET  /evidence} → 404 (명세서 파일을 어디서도 못 읽음)
 *  - admin JWT 는 여전히 필요(401/403 우선).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuotePredictUnavailableTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    /** data-dir 공란 + R2 버킷 미설정 → 어떤 자산도 못 읽는 상태를 강제. */
    @DynamicPropertySource
    static void noSources(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir", () -> "");
        registry.add("autoquote.r2-bucket", () -> "");
    }

    private HttpHeaders adminHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    @Test
    void predict_whenUnprovisioned_returns503() {
        ResponseEntity<String> res = rest.exchange("/api/admin/autoquote/predict", HttpMethod.POST,
                new HttpEntity<>("{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\"}]}", adminHeaders()),
                String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(res.getBody()).contains("autoquote_data_unavailable");
    }

    @Test
    void evidence_whenUnprovisioned_returns404() {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void predict_whenUnprovisioned_withoutJwt_stillReturns401() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> res = rest.exchange("/api/admin/autoquote/predict", HttpMethod.POST,
                new HttpEntity<>("{\"client\":\"x\",\"items\":[{\"text\":\"y\"}]}", h), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
