package com.example.backend.autoquote;

import com.example.backend.autoquote.analytics.SalesAnalyticsService;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 매출분석 — 홈페이지 완료 명세서만, 임시저장·딸린주문·휴지통 제외, 발행일 기준 집계. */
class SalesAnalyticsServiceTest {

    @Test
    void aggregatesOnlyCompletedHomepageStatements() {
        DriverManagerDataSource ds = new DriverManagerDataSource("jdbc:h2:mem:sa;DB_CLOSE_DELAY=-1", "sa", "");
        JdbcTemplate j = new JdbcTemplate(ds);
        j.execute("CREATE TABLE client_users (id BIGINT PRIMARY KEY, company_name VARCHAR(100))");
        j.execute("CREATE TABLE orders (id BIGINT PRIMARY KEY, order_number VARCHAR(40), client_id BIGINT, deleted_at TIMESTAMP)");
        j.execute("CREATE TABLE autoquote_estimate (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT, grid_json CLOB,"
                + " easyform_uploaded_at TIMESTAMP, updated_at TIMESTAMP)");
        j.update("INSERT INTO client_users VALUES (1,'오디'),(2,'나라광고')");
        j.update("INSERT INTO orders VALUES (10,'주문-1',1,NULL),(11,'주문-2',2,NULL),(12,'주문-3',1,NULL),"
                + "(13,'주문-4',2,NULL),(14,'주문-5',1,CURRENT_TIMESTAMP)");
        LocalDate t = LocalDate.now();
        String today = t.toString();
        String grid = "{\"grid\":[{\"품목코드\":\"아크릴5T\",\"품목\":\"간판\",\"수량\":\"2\",\"단가\":\"50,000\"}],\"total\":100000";
        // 완료(발행일 = efKey)
        j.update("INSERT INTO autoquote_estimate(order_id,grid_json,easyform_uploaded_at) VALUES (10,?,CURRENT_TIMESTAMP)",
                grid + ",\"easyformSync\":{\"efKey\":\"1|" + t.toString().replace('-', '.') + "|110000\"}}");
        // 완료(efKey 없음 → 입력날짜), total 없음 → 라인합 3*20000
        j.update("INSERT INTO autoquote_estimate(order_id,grid_json,easyform_uploaded_at) VALUES (11,?,CURRENT_TIMESTAMP)",
                "{\"grid\":[{\"품목코드\":\"200\",\"품목\":\"스텐 후렘(강남점)\",\"수량\":\"3\",\"단가\":\"20000\"}]}");
        // 임시저장(미완료) — 제외
        j.update("INSERT INTO autoquote_estimate(order_id,grid_json) VALUES (12,?)", grid + "}");
        // 딸린 주문 — 제외
        j.update("INSERT INTO autoquote_estimate(order_id,grid_json,easyform_uploaded_at) VALUES (13,?,CURRENT_TIMESTAMP)",
                "{\"sharedWith\":10}");
        // 휴지통 주문 — 제외
        j.update("INSERT INTO autoquote_estimate(order_id,grid_json,easyform_uploaded_at) VALUES (14,?,CURRENT_TIMESTAMP)",
                grid + "}");

        SalesAnalyticsService.SalesAnalytics a = new SalesAnalyticsService(j).rebuild();
        assertEquals(2, a.summary().invoices());
        assertEquals(160000, a.summary().totalRevenue());
        assertEquals(160000, a.thisMonth().revenue());
        assertEquals(160000, a.thisMonth().todayRevenue());
        assertEquals(today, a.daily().get(a.daily().size() - 1).key());
        assertEquals(60, a.daily().size());
        assertEquals("오디", a.topClients().get(0).name());
        assertEquals("아크릴", a.topItems().get(0).name());
        assertEquals(2, a.recent().size());
        assertEquals(2, a.materials().size());
    }
}
