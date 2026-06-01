package com.example.backend.autoquote.vision;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 리질리언스 정책의 정확한 재시도 "횟수"를 서비스 레벨에서 결정적으로 검증한다 — HTTP 왕복을
 * 거치지 않으므로(테스트용 Apache HttpClient 의 POST 재시도 같은) 잡음 없이 카운트를 단언할 수 있다.
 * HTTP 상태/본문 매핑은 {@link com.example.backend.controller.AutoQuoteVisionControllerTest} 가 별도로 검증.
 *
 * 백오프는 5ms 로 작게, 타임아웃은 넉넉히(500ms) 둬 재시도 경로가 예산 안에서 끝나게 한다.
 */
class VisionProxyServiceTest {

    private final VisionClient client = mock(VisionClient.class);
    private final VisionExecutor executor = new VisionExecutor();
    private final VisionProxyService service =
            new VisionProxyService(client, executor, 500L, new long[]{5L, 5L}, 5L);

    private static final Map<String, Object> OK = Map.of("client", "현대사인", "sign_types", java.util.List.of("채널"));

    @AfterEach
    void tearDown() {
        executor.shutdown();
    }

    private VisionApiException callExpectingFailure() {
        return catchThrowableOfType(
                () -> service.extract("aGVsbG8=", "png", null), VisionApiException.class);
    }

    @Test
    void success_callsUpstreamOnce() throws Exception {
        when(client.extract(any(), any(), any())).thenReturn(OK);

        Map<String, Object> out = service.extract("aGVsbG8=", "png", null);

        assertThat(out).containsKey("client");
        verify(client, times(1)).extract(any(), any(), any());
    }

    @Test
    void rateLimited_retriesTwice_thenThrows429Busy() throws Exception {
        when(client.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.RateLimited("429", null));

        VisionApiException ex = callExpectingFailure();

        assertThat(ex.status()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(ex.errorCode()).isEqualTo("vision_busy");
        assertThat(ex.retryable()).isTrue();
        verify(client, times(3)).extract(any(), any(), any()); // 1 + 2 retries
    }

    @Test
    void rateLimited_thenSucceeds_returnsAndStops() throws Exception {
        when(client.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.RateLimited("429", null))
                .thenReturn(OK);

        Map<String, Object> out = service.extract("aGVsbG8=", "png", null);

        assertThat(out).containsKey("client");
        verify(client, times(2)).extract(any(), any(), any());
    }

    @Test
    void upstream_retriesOnce_thenThrows502() throws Exception {
        when(client.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.Upstream("5xx", null));

        VisionApiException ex = callExpectingFailure();

        assertThat(ex.status()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(ex.errorCode()).isEqualTo("vision_upstream");
        assertThat(ex.retryable()).isNull();
        verify(client, times(2)).extract(any(), any(), any()); // 1 + 1 retry
    }

    @Test
    void unparsable_reasksOnce_thenThrows422() throws Exception {
        when(client.extract(any(), any(), any()))
                .thenThrow(new VisionClientException.Unparsable("bad", null));

        VisionApiException ex = callExpectingFailure();

        assertThat(ex.status()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(ex.errorCode()).isEqualTo("vision_unparsable");
        verify(client, times(2)).extract(any(), any(), any()); // 1 + 1 re-ask
    }

    @Test
    void jitter_isActuallyApplied_withinSpecBounds_for1sAnd3sBackoff() {
        // 스펙: 지수 백오프(1s,3s) + 지터. "지터가 실제로 적용됨"을 증명한다 — 단순히 분기만 도는 게 아니라
        // 베이스에 0~249ms 가 더해져 (a) 베이스를 넘는 값이 나오고 (b) 값이 한 가지로 고정되지 않는지.
        assertJitterApplied(1000L);
        assertJitterApplied(3000L);

        // baseMs<=0 이면 지터 없음(정확히 0).
        assertThat(service.jitteredDelayMs(0L)).isZero();
    }

    private void assertJitterApplied(long baseMs) {
        java.util.Set<Long> seen = new java.util.HashSet<>();
        long max = baseMs;
        for (int i = 0; i < 400; i++) {
            long d = service.jitteredDelayMs(baseMs);
            assertThat(d).isGreaterThanOrEqualTo(baseMs).isLessThan(baseMs + 250); // 0~249ms 지터 경계
            seen.add(d);
            max = Math.max(max, d);
        }
        assertThat(seen.size()).isGreaterThan(1);  // 한 값으로 고정 아님 → 지터 실재
        assertThat(max).isGreaterThan(baseMs);     // 적어도 한 번은 베이스 초과(지터>0)
    }

    @Test
    void timeoutBudget_exceeded_throws504() throws Exception {
        when(client.extract(any(), any(), any())).thenAnswer(inv -> {
            Thread.sleep(3000);
            return OK;
        });

        assertThatThrownBy(() -> service.extract("aGVsbG8=", "png", null))
                .isInstanceOf(VisionApiException.class)
                .satisfies(t -> {
                    VisionApiException v = (VisionApiException) t;
                    assertThat(v.status()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT);
                    assertThat(v.errorCode()).isEqualTo("vision_timeout");
                });
    }
}
