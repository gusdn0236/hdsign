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

import java.io.ByteArrayInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * slice-6 R2 소스 검증: {@code autoquote.data-dir} 가 미설정이고 {@code r2.bucket} 이 설정된
 * 운영 모드에서, 컨트롤러가 R2(S3 호환) 객체를 받아 corpus/priors 를 서빙하는지 본다.
 *
 * <b>실제 R2 네트워크는 절대 호출하지 않는다.</b> {@link S3Client} 빈을 {@code @MockBean} 으로
 * 대체하고 {@code getObject} 가 {@code autoquote-fixtures} 의 작은 가짜 바이트를 돌려주게 한다.
 * (a) /corpus + /priors 200 + 모양, (f) ETag + If-None-Match → 304 까지 R2 소스 위에서 검증한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuoteR2SourceTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    @MockBean
    private S3Client s3Client;

    private final ObjectMapper json = new ObjectMapper();

    /** 파일시스템 소스는 끄고(blank) R2 버킷만 켜서 R2 경로를 강제한다. */
    @DynamicPropertySource
    static void r2Only(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir", () -> "");
        registry.add("r2.bucket", () -> "autoquote-test-bucket");
        registry.add("autoquote.r2-prefix", () -> "autoquote/");
    }

    /** getObject(key) → autoquote-fixtures 의 작은 가짜 JSON 바이트를 R2 응답처럼 흘려준다. */
    @BeforeEach
    void stubR2() throws Exception {
        when(s3Client.getObject(any(GetObjectRequest.class))).thenAnswer(inv -> {
            GetObjectRequest req = inv.getArgument(0);
            // prefix 'autoquote/' 가 붙은 키여야 한다(컨트롤러가 r2-prefix+name 으로 요청).
            assertThat(req.bucket()).isEqualTo("autoquote-test-bucket");
            assertThat(req.key()).startsWith("autoquote/");
            String name = req.key().substring("autoquote/".length());
            byte[] bytes = fixtureBytes(name);
            return new ResponseInputStream<>(
                    GetObjectResponse.builder().contentLength((long) bytes.length).build(),
                    AbortableInputStream.create(new ByteArrayInputStream(bytes)));
        });
    }

    private static byte[] fixtureBytes(String name) throws Exception {
        try (var in = AdminAutoQuoteR2SourceTest.class.getResourceAsStream("/autoquote-fixtures/" + name)) {
            assertThat(in).as("fixture %s must exist", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private HttpEntity<Void> adminAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return new HttpEntity<>(headers);
    }

    @Test
    void corpus_fromR2_returns200_withCorpusShape() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getHeaders().getContentType().includes(MediaType.APPLICATION_JSON)).isTrue();

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("lines").isArray()).isTrue();
        assertThat(body.get("lines")).isNotEmpty();
        JsonNode first = body.get("lines").get(0);
        assertThat(first.has("category")).isTrue();
        assertThat(first.has("unitPrice")).isTrue();
    }

    @Test
    void priors_fromR2_returns200_withPriorsShape() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.has("bridges")).isTrue();
        assertThat(body.has("reorderPairs")).isTrue();
        assertThat(body.get("sizeBuckets").isObject()).isTrue();
        assertThat(body.get("synthDigest").isObject()).isTrue();
    }

    @Test
    void corpus_fromR2_isCacheable_etagThenNotModified() {
        ResponseEntity<String> first = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);

        String etag = first.getHeaders().getETag();
        assertThat(etag).as("ETag must be present for R2-sourced corpus").isNotBlank();
        assertThat(etag).startsWith("\"").endsWith("\"");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        headers.setIfNoneMatch(etag);
        ResponseEntity<String> second = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.NOT_MODIFIED);
        assertThat(second.getBody()).isNull();
    }

    @Test
    void corpus_fromR2_withoutJwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity(
                "/api/admin/autoquote/corpus", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
