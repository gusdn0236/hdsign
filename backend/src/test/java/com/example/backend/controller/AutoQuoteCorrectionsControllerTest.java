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
 * @slice-3 자동견적 보정(correction) 공유 저장소의 관찰 가능한 동작 검증.
 *
 * 풀 컨텍스트({@code @SpringBootTest})를 띄워 실제 SecurityFilterChain·JwtFilter·컨트롤러·JPA 를 거친다.
 * {@code autoquote-it} 프로파일은 인메모리 H2(MySQL 모드) + ddl-auto=create-drop 이라
 * {@code @Entity} AutoQuoteCorrection 테이블이 자동 생성된다(운영 MySQL/Flyway 불필요).
 *
 * 검증 항목:
 *  - POST → GET 으로 저장한 보정이 그대로 돌아온다(S5: server-shared persistence).
 *  - author 는 JWT principal 에서 파생되고, 본문에 실린 'author' 는 무시·덮어쓴다(스푸핑 불가).
 *  - admin JWT 없으면 401, 비-admin JWT 면 403.
 *  - priority 생략 시 기본 100 적용.
 *  - 필수 필드 누락 시 400.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("autoquote-it")
class AutoQuoteCorrectionsControllerTest {

    private static final String URL = "/api/admin/autoquote/corrections";

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    private final ObjectMapper json = new ObjectMapper();

    // ---- helpers ---------------------------------------------------------

    private HttpHeaders adminHeaders(String adminName) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateAdminToken(adminName));
        return h;
    }

    private HttpEntity<String> adminPost(String adminName, String body) {
        return new HttpEntity<>(body, adminHeaders(adminName));
    }

    private ResponseEntity<String> postAsAdmin(String adminName, String body) {
        return rest.exchange(URL, HttpMethod.POST, adminPost(adminName, body), String.class);
    }

    // ---- POST → GET round-trip (S5 server-shared persistence) -------------

    @Test
    void post_thenGet_returnsSavedCorrection() throws Exception {
        String featureKey = "channel:acrylic:led:roundtrip-" + System.nanoTime();
        String body = "{"
                + "\"featureKey\":\"" + featureKey + "\","
                + "\"correctedUnitPrice\":185000.50,"
                + "\"explanation\":\"현장 실측 반영 단가 상향\","
                + "\"priority\":20"
                + "}";

        ResponseEntity<String> created = postAsAdmin("alice", body);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode saved = json.readTree(created.getBody());
        assertThat(saved.get("id").asLong()).isPositive();
        assertThat(saved.get("featureKey").asText()).isEqualTo(featureKey);
        assertThat(saved.get("correctedUnitPrice").asDouble()).isEqualTo(185000.50);
        assertThat(saved.get("explanation").asText()).isEqualTo("현장 실측 반영 단가 상향");
        assertThat(saved.get("priority").asInt()).isEqualTo(20);
        assertThat(saved.get("createdAt").asText()).isNotBlank();

        // GET 으로 다시 조회 — 방금 저장한 보정이 공유 목록에 들어있어야 한다(서버 영속).
        ResponseEntity<String> listed = rest.exchange(
                URL, HttpMethod.GET, new HttpEntity<>(adminHeaders("bob")), String.class);
        assertThat(listed.getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode arr = json.readTree(listed.getBody());
        assertThat(arr.isArray()).isTrue();
        JsonNode found = null;
        for (JsonNode n : arr) {
            if (featureKey.equals(n.get("featureKey").asText())) {
                found = n;
                break;
            }
        }
        assertThat(found).as("saved correction must appear in the shared GET list").isNotNull();
        assertThat(found.get("correctedUnitPrice").asDouble()).isEqualTo(185000.50);
        assertThat(found.get("explanation").asText()).isEqualTo("현장 실측 반영 단가 상향");
        assertThat(found.get("author").asText()).isEqualTo("alice");
    }

    // ---- author derived from JWT principal, body 'author' ignored ---------

    @Test
    void author_isDerivedFromJwtPrincipal_notFromBody() throws Exception {
        String featureKey = "flex:spoofguard-" + System.nanoTime();
        // 본문에 author 를 거짓으로 실어 보낸다 — 서버는 무시하고 principal("carol")로 덮어야 한다.
        String body = "{"
                + "\"featureKey\":\"" + featureKey + "\","
                + "\"correctedUnitPrice\":99000,"
                + "\"explanation\":\"스푸핑 시도\","
                + "\"author\":\"attacker-spoofed\""
                + "}";

        ResponseEntity<String> created = postAsAdmin("carol", body);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode saved = json.readTree(created.getBody());
        assertThat(saved.get("author").asText())
                .as("author must come from the authenticated principal, never the request body")
                .isEqualTo("carol");
        assertThat(saved.get("author").asText()).isNotEqualTo("attacker-spoofed");

        // 서버 측 저장값으로도(별 관리자 GET) 확인 — 응답뿐 아니라 영속 레코드도 principal 이어야 한다.
        ResponseEntity<String> listed = rest.exchange(
                URL, HttpMethod.GET, new HttpEntity<>(adminHeaders("dave")), String.class);
        JsonNode arr = json.readTree(listed.getBody());
        boolean verified = false;
        for (JsonNode n : arr) {
            if (featureKey.equals(n.get("featureKey").asText())) {
                assertThat(n.get("author").asText()).isEqualTo("carol");
                verified = true;
            }
        }
        assertThat(verified).isTrue();
    }

    // ---- priority default ------------------------------------------------

    @Test
    void priority_defaultsTo100_whenOmitted() throws Exception {
        String featureKey = "led:default-priority-" + System.nanoTime();
        String body = "{"
                + "\"featureKey\":\"" + featureKey + "\","
                + "\"correctedUnitPrice\":50000,"
                + "\"explanation\":\"우선순위 생략\""
                + "}";

        ResponseEntity<String> created = postAsAdmin("erin", body);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode saved = json.readTree(created.getBody());
        assertThat(saved.get("priority").asInt()).isEqualTo(100);
    }

    // ---- auth ------------------------------------------------------------

    @Test
    void get_without_jwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity(URL, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void post_without_jwt_returns401() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> entity = new HttpEntity<>(
                "{\"featureKey\":\"x\",\"correctedUnitPrice\":1,\"explanation\":\"y\"}", h);
        ResponseEntity<String> res = rest.exchange(URL, HttpMethod.POST, entity, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void post_with_nonAdmin_jwt_returns403() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        HttpEntity<String> entity = new HttpEntity<>(
                "{\"featureKey\":\"x\",\"correctedUnitPrice\":1,\"explanation\":\"y\"}", h);
        ResponseEntity<String> res = rest.exchange(URL, HttpMethod.POST, entity, String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void get_with_nonAdmin_jwt_returns403() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        ResponseEntity<String> res = rest.exchange(
                URL, HttpMethod.GET, new HttpEntity<>(h), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- validation (400) ------------------------------------------------

    @Test
    void post_missingFeatureKey_returns400() {
        String body = "{\"correctedUnitPrice\":1000,\"explanation\":\"키 없음\"}";
        ResponseEntity<String> res = postAsAdmin("frank", body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("missing_field");
    }

    @Test
    void post_missingPrice_returns400() {
        String body = "{\"featureKey\":\"k\",\"explanation\":\"가격 없음\"}";
        ResponseEntity<String> res = postAsAdmin("grace", body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("missing_field");
    }

    @Test
    void post_missingExplanation_returns400() {
        String body = "{\"featureKey\":\"k\",\"correctedUnitPrice\":1000}";
        ResponseEntity<String> res = postAsAdmin("heidi", body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("missing_field");
    }
}
