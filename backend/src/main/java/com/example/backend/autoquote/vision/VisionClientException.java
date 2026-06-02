package com.example.backend.autoquote.vision;

/**
 * 단일 업스트림 시도(한 번의 Claude 호출)가 실패한 사유를 분류해 던지는 예외.
 *
 * <p>리질리언스(재시도/타임아웃/HTTP 매핑)는 {@link VisionProxyService} 가 전담한다.
 * {@link VisionClient} 구현은 "한 번의 시도"만 수행하고, 실패 종류를 아래 하위 타입으로
 * 알려주기만 한다. 이렇게 분리해야 SDK·실키 없이도 서비스의 재시도/매핑 정책을 단위테스트할 수 있다.
 *
 * <p><b>IRON LAW</b>: 어떤 메시지에도 ANTHROPIC_API_KEY 를 담지 않는다.
 */
public abstract class VisionClientException extends Exception {

    protected VisionClientException(String message, Throwable cause) {
        super(message, cause);
    }

    /** Anthropic 429 (rate limit) — 백오프 후 재시도 대상. */
    public static final class RateLimited extends VisionClientException {
        public RateLimited(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** 업스트림 5xx / 네트워크·IO 오류 — 일시적일 수 있어 한 번 재시도 대상. */
    public static final class Upstream extends VisionClientException {
        public Upstream(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** tool_use 블록이 없거나 입력이 기대 스키마(JSON object)로 파싱되지 않음 — 재요청 1회 대상. */
    public static final class Unparsable extends VisionClientException {
        public Unparsable(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
