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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 자동견적 corpus/priors 엔드포인트의 관찰 가능한 동작 검증:
 *  - admin JWT 로 200 + 올바른 JSON 모양(corpus.lines[], priors.sizeBuckets/synthDigest)
 *  - JWT 없으면 401
 *  - ETag 부여 + If-None-Match 재요청 시 304 (캐시 가능)
 *
 * 풀 컨텍스트({@code @SpringBootTest})를 띄워 실제 SecurityFilterChain·JwtFilter 를 거친다.
 * 관리자 토큰은 {@link JwtUtil} 로 직접 발급 — DB 의 관리자 계정 시드에 의존하지 않는다
 * (JwtFilter 가 토큰의 role 만으로 ROLE_ADMIN 을 부여하므로 충분하다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuoteControllerTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    private final ObjectMapper json = new ObjectMapper();

    private HttpEntity<Void> adminAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return new HttpEntity<>(headers);
    }

    /** 유효하지만 권한이 다른(거래처/CLIENT) 토큰 — 인증은 되나 ROLE_ADMIN 이 아니다. */
    private HttpEntity<Void> clientAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        return new HttpEntity<>(headers);
    }

    @Test
    void corpus_returns200_withCorpusShape() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getHeaders().getContentType()).isNotNull();
        assertThat(res.getHeaders().getContentType().includes(MediaType.APPLICATION_JSON)).isTrue();

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.has("_meta")).isTrue();
        assertThat(body.get("lines").isArray()).isTrue();
        assertThat(body.get("lines")).isNotEmpty();
        // A corpus line carries at least a category + unit price (engine tier ① fields).
        JsonNode first = body.get("lines").get(0);
        assertThat(first.has("category")).isTrue();
        assertThat(first.has("unitPrice")).isTrue();
    }

    @Test
    void priors_returns200_withPriorsShape() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode body = json.readTree(res.getBody());
        // The four documented prior groups (engine `Priors` contract).
        assertThat(body.has("bridges")).isTrue();
        assertThat(body.has("reorderPairs")).isTrue();
        assertThat(body.get("sizeBuckets").isObject()).isTrue();
        assertThat(body.get("synthDigest").isObject()).isTrue();
        // sizeBuckets is a learned size->price curve: category -> [{maxHeight, unitPrice}].
        assertThat(body.get("sizeBuckets").size()).isGreaterThan(0);
        JsonNode anyCurve = body.get("sizeBuckets").elements().next();
        assertThat(anyCurve.isArray()).isTrue();
        assertThat(anyCurve.get(0).has("maxHeight")).isTrue();
        assertThat(anyCurve.get(0).has("unitPrice")).isTrue();
        assertThat(body.get("synthDigest").get("lineCount").asInt()).isGreaterThan(0);
    }

    @Test
    void corpus_without_jwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity(
                "/api/admin/autoquote/corpus", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void priors_without_jwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity(
                "/api/admin/autoquote/priors", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // 인증은 됐지만 role 이 ADMIN 이 아닌(CLIENT) 토큰은 403 이어야 한다 — 기밀 코퍼스 유출 방지.
    // @PreAuthorize 가 any-authenticated 로 약화되면 이 단언이 깨져 누수를 잡아낸다(Anti-Scenario 1).

    @Test
    void corpus_with_nonAdmin_jwt_returns403() {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, clientAuth(), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        // 거부 응답이 코퍼스 본문을 흘리지 않았는지도 확인(엔진 tier ① 필드가 없어야 한다).
        assertThat(res.getBody() == null || !res.getBody().contains("unitPrice")).isTrue();
    }

    @Test
    void priors_with_nonAdmin_jwt_returns403() {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, clientAuth(), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void corpus_isCacheable_etagThenNotModified() {
        ResponseEntity<String> first = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);

        String etag = first.getHeaders().getETag();
        assertThat(etag).as("ETag header must be present for caching the 4.66MB corpus").isNotBlank();
        assertThat(etag).startsWith("\"").endsWith("\"");

        // 동일 ETag 로 재요청 → 304 Not Modified, 본문(4.66MB) 재전송 없음.
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        headers.setIfNoneMatch(etag);
        ResponseEntity<String> second = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.NOT_MODIFIED);
        assertThat(second.getBody()).isNull();
    }

    @Test
    void priors_isCacheable_etagThenNotModified() {
        ResponseEntity<String> first = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);

        String etag = first.getHeaders().getETag();
        assertThat(etag).as("ETag header must be present for caching").isNotBlank();
        assertThat(etag).startsWith("\"").endsWith("\"");

        // Re-request with the same ETag → 304 Not Modified, no body re-transfer.
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        headers.setIfNoneMatch(etag);
        ResponseEntity<String> second = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.NOT_MODIFIED);
        assertThat(second.getBody()).isNull();
    }
}
