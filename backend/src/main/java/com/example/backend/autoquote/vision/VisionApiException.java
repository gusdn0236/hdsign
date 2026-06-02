package com.example.backend.autoquote.vision;

import org.springframework.http.HttpStatus;

/**
 * 비전 프록시가 클라이언트에게 돌려줄 최종 오류(스펙 'Vision proxy resilience policy').
 * {@link VisionProxyService} 가 재시도 소진/타임아웃 시 던지고, 컨트롤러가 받아
 * {@code {error:string, retryable?:boolean}} 본문 + 해당 HTTP 상태로 변환한다.
 *
 * <p>메시지/코드 어디에도 API 키를 담지 않는다(IRON LAW).
 */
public class VisionApiException extends RuntimeException {

    private final HttpStatus status;
    private final String errorCode;
    private final Boolean retryable;

    public VisionApiException(HttpStatus status, String errorCode, Boolean retryable) {
        super(errorCode);
        this.status = status;
        this.errorCode = errorCode;
        this.retryable = retryable;
    }

    public HttpStatus status() {
        return status;
    }

    public String errorCode() {
        return errorCode;
    }

    /** null 이면 본문에 retryable 필드를 넣지 않는다. */
    public Boolean retryable() {
        return retryable;
    }
}
