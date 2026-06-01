package com.example.backend.autoquote.vision;

import java.util.Map;

/**
 * "한 번의 업스트림 시도" 추상화. 작업지시서 이미지를 Claude(forced tool-use)로 보내
 * 구조화된 라인아이템(rich schema)을 추출한다.
 *
 * <p>재시도/타임아웃/HTTP 상태 매핑은 일절 하지 않는다 — 그건 {@link VisionProxyService} 의 몫이다.
 * 실패는 {@link VisionClientException} 의 하위 타입으로 분류해 던진다. 이 인터페이스 덕분에
 * 테스트는 실제 SDK·실 API 키 없이 stub 으로 리질리언스 정책을 검증할 수 있다.
 */
public interface VisionClient {

    /**
     * @param imageBase64 base64 인코딩된 이미지 데이터(데이터 URI 접두사 없는 순수 base64)
     * @param mediaType   정규화된 미디어 타입 — {@code png} / {@code jpeg} / {@code webp} 중 하나
     * @param hints       추출 힌트(거래처/품목 단서 등). null 가능.
     * @return tool_use 입력을 JSON object 로 변환한 Map (rich schema 키들)
     * @throws VisionClientException 한 번의 시도가 실패했을 때(분류된 하위 타입)
     */
    Map<String, Object> extract(String imageBase64, String mediaType, Map<String, Object> hints)
            throws VisionClientException;
}
