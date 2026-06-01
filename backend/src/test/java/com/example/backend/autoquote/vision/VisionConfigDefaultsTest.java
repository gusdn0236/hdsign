package com.example.backend.autoquote.vision;

import com.example.backend.controller.AutoQuoteVisionController;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 스펙 <b>기본 임계값</b>이 운영 빈에 실제로 박혀 있는지 검증한다 — 테스트가 작은 값으로 덮어쓴
 * 케이스만 보면 회귀(기본 80MB→다른 값, 60s→다른 값, 1s/3s 백오프 변경)를 못 잡는다.
 *
 * <p>어떤 vision 설정도 오버라이드하지 않은 채 풀 컨텍스트를 띄워(autoquote-it/H2, 키 불필요)
 * 실제 {@link VisionProxyService}/{@link AutoQuoteVisionController} 빈의 구성값을 단언한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@ActiveProfiles("autoquote-it")
class VisionConfigDefaultsTest {

    @Autowired
    private VisionProxyService service;

    @Autowired
    private AutoQuoteVisionController controller;

    @Test
    void timeoutBudget_defaultsTo60Seconds() {
        assertThat(service.timeoutMs()).isEqualTo(60_000L);
    }

    @Test
    void rateLimitBackoff_defaultsTo1sThen3s() {
        assertThat(service.rateLimitBackoffMs()).containsExactly(1_000L, 3_000L);
    }

    @Test
    void maxBytes_defaultsTo80MB() throws Exception {
        // 컨트롤러의 maxBytes() 는 패키지-프라이빗(다른 패키지) → 리플렉션으로 운영 기본값을 읽는다.
        Method m = AutoQuoteVisionController.class.getDeclaredMethod("maxBytes");
        m.setAccessible(true);
        long maxBytes = (long) m.invoke(controller);
        assertThat(maxBytes).isEqualTo(80L * 1024 * 1024); // 83,886,080
    }
}
