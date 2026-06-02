package com.example.backend.controller;

import com.example.backend.security.JwtUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.when;

/**
 * slice-6 R2 오류 graceful 처리: R2 가 켜져 있으나({@code r2.bucket} 설정) 객체가 없거나
 * (NoSuchKey) S3 오류가 나면, 500/stacktrace 가 아니라
 * <b>503 {"error":"autoquote_data_unavailable"}</b> 로 응답해야 한다(미스는 캐시하지 않음).
 *
 * 실제 R2 네트워크는 호출하지 않는다 — {@code @MockBean} 으로 {@code getObject} 가 예외를 던지게 한다.
 * 성공 테스트와 컨텍스트(캐시)를 공유하지 않도록 별도 클래스로 둔다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuoteR2ErrorTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    @MockBean
    private S3Client s3Client;

    private final ObjectMapper json = new ObjectMapper();

    @DynamicPropertySource
    static void r2Only(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir", () -> "");
        registry.add("r2.bucket", () -> "autoquote-test-bucket");
        registry.add("autoquote.r2-prefix", () -> "autoquote/");
    }

    /** corpus → NoSuchKey, priors → S3Exception. 둘 다 graceful 503 로 떨어져야 한다. */
    @BeforeEach
    void stubErrors() {
        when(s3Client.getObject(argThat((GetObjectRequest r) -> r != null && r.key().endsWith("corpus.json"))))
                .thenThrow(NoSuchKeyException.builder().message("no such key").build());
        when(s3Client.getObject(argThat((GetObjectRequest r) -> r != null && r.key().endsWith("priors.json"))))
                .thenThrow(S3Exception.builder().message("boom").build());
    }

    private HttpEntity<Void> adminAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return new HttpEntity<>(headers);
    }

    @Test
    void corpus_whenR2NoSuchKey_returns503_withErrorBody() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
        // 503 본문에 R2 키/예외 메시지 등 내부 정보가 새지 않아야 한다.
        assertThat(res.getBody()).doesNotContain("no such key").doesNotContain("autoquote-test-bucket");
    }

    @Test
    void priors_whenR2S3Exception_returns503_withErrorBody() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
    }
}
