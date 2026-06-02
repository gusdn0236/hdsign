package com.example.backend.autoquote.vision;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 비전 프록시 리질리언스 오케스트레이션 (스펙 'Vision proxy resilience policy').
 *
 * <ul>
 *   <li><b>타임아웃</b>: 업스트림 호출 예산 {@code autoquote.vision.timeout-ms}(기본 60초).
 *       초과 시 504 {@code vision_timeout}.</li>
 *   <li><b>429(rate limit)</b>: 최대 2회 재시도, 지수 백오프(1s,3s)+지터. 그래도 429면
 *       429 {@code vision_busy, retryable:true}.</li>
 *   <li><b>5xx/네트워크</b>: 1회 재시도 후 502 {@code vision_upstream}.</li>
 *   <li><b>파싱 불가(스키마 불일치)</b>: 1회 재요청 후 422 {@code vision_unparsable}.</li>
 * </ul>
 *
 * 단일 시도는 {@link VisionClient} 가 수행하고 실패 종류만 {@link VisionClientException} 으로
 * 알려준다 — 덕분에 SDK·실키 없이 stub 으로 모든 매핑을 단위테스트할 수 있다.
 */
@Service
public class VisionProxyService {

    private final VisionClient client;
    private final ExecutorService executor;
    private final long timeoutMs;
    private final long[] rateLimitBackoffMs;
    private final long upstreamBackoffMs;

    public VisionProxyService(
            VisionClient client,
            VisionExecutor visionExecutor,
            @Value("${autoquote.vision.timeout-ms:60000}") long timeoutMs,
            @Value("${autoquote.vision.rate-limit-backoff-ms:1000,3000}") long[] rateLimitBackoffMs,
            @Value("${autoquote.vision.upstream-backoff-ms:1000}") long upstreamBackoffMs) {
        this.client = client;
        this.executor = visionExecutor.get();
        this.timeoutMs = timeoutMs;
        this.rateLimitBackoffMs = rateLimitBackoffMs;
        this.upstreamBackoffMs = upstreamBackoffMs;
    }

    /**
     * 작업지시서 이미지를 구조화 라인아이템으로 추출한다. 실패 시 정책에 맞는
     * {@link VisionApiException}(상태/코드/retryable)을 던진다.
     */
    public Map<String, Object> extract(String imageBase64, String mediaType, Map<String, Object> hints) {
        Callable<Map<String, Object>> task = () -> runWithRetries(imageBase64, mediaType, hints);
        Future<Map<String, Object>> future = executor.submit(task);
        try {
            // 업스트림 예산: 재시도/백오프를 모두 포함한 전체 작업에 60초 상한을 건다.
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true); // 워커 스레드 인터럽트 → 대기 중 sleep/호출 중단
            throw new VisionApiException(HttpStatus.GATEWAY_TIMEOUT, "vision_timeout", null);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof VisionApiException ve) {
                throw ve;
            }
            // 예상치 못한 오류도 키 누수 없이 502 로 떨어뜨린다.
            throw new VisionApiException(HttpStatus.BAD_GATEWAY, "vision_upstream", null);
        } catch (InterruptedException e) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw new VisionApiException(HttpStatus.GATEWAY_TIMEOUT, "vision_timeout", null);
        }
    }

    /**
     * 한 번의 시도를 반복하며 실패 종류별 재시도 한도를 적용한다. 한도를 넘기면
     * 최종 {@link VisionApiException} 을 던진다.
     */
    private Map<String, Object> runWithRetries(String imageBase64, String mediaType, Map<String, Object> hints)
            throws InterruptedException {
        int rateLimitRetries = 0; // 허용 2회
        boolean upstreamRetried = false; // 허용 1회
        boolean reasked = false; // 허용 1회(re-ask)

        while (true) {
            try {
                return client.extract(imageBase64, mediaType, hints);
            } catch (VisionClientException.RateLimited e) {
                if (rateLimitRetries < rateLimitBackoffMs.length) {
                    sleepWithJitter(rateLimitBackoffMs[rateLimitRetries]);
                    rateLimitRetries++;
                    continue;
                }
                throw new VisionApiException(HttpStatus.TOO_MANY_REQUESTS, "vision_busy", true);
            } catch (VisionClientException.Upstream e) {
                if (!upstreamRetried) {
                    upstreamRetried = true;
                    sleepWithJitter(upstreamBackoffMs);
                    continue;
                }
                throw new VisionApiException(HttpStatus.BAD_GATEWAY, "vision_upstream", null);
            } catch (VisionClientException.Unparsable e) {
                if (!reasked) {
                    reasked = true; // 같은 입력으로 한 번만 재요청
                    continue;
                }
                throw new VisionApiException(HttpStatus.UNPROCESSABLE_ENTITY, "vision_unparsable", null);
            } catch (VisionClientException e) {
                // 분류 외 예외는 안전하게 502.
                throw new VisionApiException(HttpStatus.BAD_GATEWAY, "vision_upstream", null);
            }
        }
    }

    /** 백오프 + 0~250ms 지터. 인터럽트(타임아웃 취소) 시 즉시 중단 신호를 전파한다. */
    private void sleepWithJitter(long baseMs) throws InterruptedException {
        Thread.sleep(jitteredDelayMs(baseMs));
    }

    /**
     * 백오프 베이스에 0~249ms 지터를 더한 실제 대기 시간(ms). 지터가 "실제로" 적용됨을 단위테스트로
     * 증명하기 위해 sleep 과 분리했다(스펙: 1s,3s 지수 백오프 + 지터). {@code baseMs<=0} 이면 지터 없음.
     */
    long jitteredDelayMs(long baseMs) {
        long jitter = baseMs <= 0 ? 0 : ThreadLocalRandom.current().nextLong(0, 250);
        return baseMs + jitter;
    }

    /** 스펙 기본 업스트림 예산(기본 60초)을 그대로 보유하는지 검증용 접근자. */
    long timeoutMs() {
        return timeoutMs;
    }

    /** 스펙 기본 rate-limit 백오프 시퀀스(기본 1s,3s)를 그대로 보유하는지 검증용 접근자. */
    long[] rateLimitBackoffMs() {
        return rateLimitBackoffMs.clone();
    }
}
