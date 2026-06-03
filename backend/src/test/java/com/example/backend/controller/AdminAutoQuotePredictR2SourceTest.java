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
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;

import java.io.ByteArrayInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * 운영 모드(파일시스템 미설정 + 전용 비공개 R2 버킷)에서 /predict·/evidence 가 R2 객체로 동작하는지.
 *
 * <p>{@link S3Client} 를 {@code @MockBean} 으로 대체해 {@code autoquote-fixtures} 의 작은 바이트를
 * R2 응답처럼 흘린다(실 네트워크 호출 없음). priced_index/easyform/사진 모두 R2 경로로 서빙됨을
 * 확인하고, 없는 키(NoSuchKey)는 graceful(503/404)로 떨어지는지 본다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuotePredictR2SourceTest {

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
        registry.add("autoquote.r2-bucket", () -> "autoquote-test-bucket");
        registry.add("autoquote.r2-prefix", () -> "autoquote/");
    }

    @BeforeEach
    void stubR2() {
        when(s3Client.getObject(any(GetObjectRequest.class))).thenAnswer(inv -> {
            GetObjectRequest req = inv.getArgument(0);
            assertThat(req.bucket()).isEqualTo("autoquote-test-bucket");
            assertThat(req.key()).startsWith("autoquote/");
            String name = req.key().substring("autoquote/".length());
            byte[] bytes = fixtureBytes(name);
            if (bytes == null) {
                throw NoSuchKeyException.builder().message("no such key").build();
            }
            return new ResponseInputStream<>(
                    GetObjectResponse.builder().contentLength((long) bytes.length).build(),
                    AbortableInputStream.create(new ByteArrayInputStream(bytes)));
        });
    }

    private static byte[] fixtureBytes(String name) throws Exception {
        try (var in = AdminAutoQuotePredictR2SourceTest.class
                .getResourceAsStream("/autoquote-fixtures/" + name)) {
            return in == null ? null : in.readAllBytes();
        }
    }

    private HttpHeaders adminHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    @Test
    void predict_fromR2_returns200_withSchema() throws Exception {
        ResponseEntity<String> res = rest.exchange("/api/admin/autoquote/predict", HttpMethod.POST,
                new HttpEntity<>("{\"client\":\"한국사인\",\"items\":[{\"text\":\"채널간판\",\"size\":\"h:300\"}]}",
                        adminHeaders()), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode p = json.readTree(res.getBody()).get(0);
        assertThat(p.get("price").asInt()).isEqualTo(100000);
        assertThat(p.hasNonNull("ref_invoice_idx")).isTrue();
        assertThat(p.get("reason").asText()).isNotBlank();
    }

    @Test
    void evidence_fromR2_returns200_withGridAndPhoto() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_2099_test.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("grid")).isNotEmpty();
        assertThat(body.get("photo_available").asBoolean()).isTrue();
    }

    @Test
    void evidence_fromR2_missingInvoiceFile_returns404() {
        // R2 에 없는 명세서 파일(NoSuchKey) → graceful 404.
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/evidence/10?file=easyform_3000_missing.json",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
