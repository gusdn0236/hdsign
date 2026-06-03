package com.example.backend.controller;

import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.OrderRepository;
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
 * slice-12 — 주문(지시서)별 자동견적 명세서(estimate) 저장/조회/이지폼표시 API 의 관찰 가능한 동작 검증.
 *
 * 풀 컨텍스트({@code @SpringBootTest}) + 실제 SecurityFilterChain·JwtFilter·컨트롤러·JPA.
 * {@code autoquote-it} 프로파일 = 인메모리 H2(MySQL 모드) + ddl-auto=create-drop 이라
 * {@code @Entity} AutoQuoteEstimate/Order/ClientUser 테이블이 자동 생성된다(운영 MySQL/Flyway 불필요).
 *
 * 검증 항목:
 *  - PUT → GET round-trip(명세서 grid 그대로 영속), PUT 은 주문당 1건 upsert.
 *  - 주문 목록(GET /api/admin/orders)에 hasEstimate / easyformUploadedAt 배지 플래그 반영.
 *  - easyform-uploaded 표시가 타임스탬프를 채운다(명세서 선행 필수 — 없으면 404).
 *  - GET estimate 없으면 404.
 *  - admin JWT 없으면 401, 비-admin JWT 면 403.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("autoquote-it")
class AutoQuoteEstimateControllerTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    @Autowired
    private OrderRepository orderRepository;

    @Autowired
    private ClientUserRepository clientUserRepository;

    private final ObjectMapper json = new ObjectMapper();

    // ---- helpers ---------------------------------------------------------

    private HttpHeaders adminHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateAdminToken("estimate-tester"));
        return h;
    }

    // 명세서를 붙일 실제 주문 1건 생성(client_id FK NOT NULL 이라 거래처도 함께 만든다).
    private Long createOrder() {
        ClientUser client = clientUserRepository.save(
                ClientUser.builder().companyName("테스트상사-" + System.nanoTime()).build());
        Order order = orderRepository.save(
                Order.builder()
                        .orderNumber("주문-test-" + System.nanoTime())
                        .client(client)
                        .title("estimate 테스트 지시서")
                        .build());
        return order.getId();
    }

    private ResponseEntity<String> putEstimate(Long orderId, String body) {
        return rest.exchange("/api/admin/orders/" + orderId + "/estimate",
                HttpMethod.PUT, new HttpEntity<>(body, adminHeaders()), String.class);
    }

    private ResponseEntity<String> getEstimate(Long orderId) {
        return rest.exchange("/api/admin/orders/" + orderId + "/estimate",
                HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
    }

    private JsonNode findInList(String url, Long orderId) throws Exception {
        ResponseEntity<String> listed = rest.exchange(
                url, HttpMethod.GET, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(listed.getStatusCode()).isEqualTo(HttpStatus.OK);
        for (JsonNode n : json.readTree(listed.getBody())) {
            if (n.get("id").asLong() == orderId) return n;
        }
        return null;
    }

    // ---- PUT → GET round-trip + upsert -----------------------------------

    @Test
    void put_thenGet_roundTrip_andUpsert() throws Exception {
        Long orderId = createOrder();

        String body = "{\"grid\":[{\"item\":\"갈바레이저\",\"spec\":\"300x200\",\"qty\":2,\"unitPrice\":15000}]}";
        ResponseEntity<String> put = putEstimate(orderId, body);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode saved = json.readTree(put.getBody());
        assertThat(saved.get("hasEstimate").asBoolean()).isTrue();
        assertThat(saved.get("savedAt").asText()).isNotBlank();
        assertThat(saved.get("estimate").get("grid").get(0).get("item").asText()).isEqualTo("갈바레이저");

        // GET 으로 다시 조회 — 명세서가 그대로 돌아온다.
        ResponseEntity<String> got = getEstimate(orderId);
        assertThat(got.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode g = json.readTree(got.getBody());
        assertThat(g.get("estimate").get("grid").get(0).get("unitPrice").asInt()).isEqualTo(15000);

        // 다시 PUT — 주문당 1건 upsert(새 행 안 생기고 내용 교체).
        String body2 = "{\"grid\":[{\"item\":\"에폭시잔넬\",\"spec\":\"500x500\",\"qty\":1,\"unitPrice\":42000}]}";
        assertThat(putEstimate(orderId, body2).getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode g2 = json.readTree(getEstimate(orderId).getBody());
        assertThat(g2.get("estimate").get("grid").get(0).get("item").asText()).isEqualTo("에폭시잔넬");
    }

    // ---- 주문 목록 배지 플래그 -------------------------------------------

    @Test
    void orderList_reflectsHasEstimateBadge() throws Exception {
        Long withEstimate = createOrder();
        Long without = createOrder();
        putEstimate(withEstimate, "{\"grid\":[]}");

        JsonNode hit = findInList("/api/admin/orders", withEstimate);
        assertThat(hit).as("estimate 저장한 주문이 목록에 있어야 한다").isNotNull();
        assertThat(hit.get("hasEstimate").asBoolean()).isTrue();

        JsonNode none = findInList("/api/admin/orders", without);
        assertThat(none).isNotNull();
        assertThat(none.get("hasEstimate").asBoolean()).isFalse();
    }

    // ---- easyform 업로드 표시 --------------------------------------------

    @Test
    void easyformUploaded_setsTimestamp_andSurfacesInList() throws Exception {
        Long orderId = createOrder();
        putEstimate(orderId, "{\"grid\":[]}");

        ResponseEntity<String> marked = rest.exchange(
                "/api/admin/orders/" + orderId + "/estimate/easyform-uploaded",
                HttpMethod.POST, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(marked.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(marked.getBody()).get("easyformUploadedAt").asText()).isNotBlank();

        JsonNode hit = findInList("/api/admin/orders", orderId);
        assertThat(hit.get("easyformUploadedAt").isNull()).isFalse();
    }

    @Test
    void easyformUploaded_withoutEstimate_returns404() {
        Long orderId = createOrder();
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/orders/" + orderId + "/estimate/easyform-uploaded",
                HttpMethod.POST, new HttpEntity<>(adminHeaders()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).contains("estimate_not_found");
    }

    @Test
    void getEstimate_whenNone_returns404() {
        Long orderId = createOrder();
        ResponseEntity<String> res = getEstimate(orderId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).contains("estimate_not_found");
    }

    // ---- auth ------------------------------------------------------------

    @Test
    void put_without_jwt_returns401() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> res = rest.exchange("/api/admin/orders/1/estimate",
                HttpMethod.PUT, new HttpEntity<>("{\"grid\":[]}", h), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void get_without_jwt_returns401() {
        ResponseEntity<String> res = rest.getForEntity("/api/admin/orders/1/estimate", String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void put_with_nonAdmin_jwt_returns403() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(jwtUtil.generateClientToken("test-client"));
        ResponseEntity<String> res = rest.exchange("/api/admin/orders/1/estimate",
                HttpMethod.PUT, new HttpEntity<>("{\"grid\":[]}", h), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }
}
