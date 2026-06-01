package com.example.backend.autoquote.vision;

import java.util.Map;

/**
 * {@code POST /api/admin/autoquote/vision} 요청 본문.
 *
 * @param imageBase64 base64 인코딩 작업지시서 이미지(데이터 URI 접두사 허용)
 * @param mediaType   {@code png}/{@code jpeg}/{@code webp} (또는 {@code image/...} 형태). 생략 시 png.
 * @param hints       추출 힌트(선택)
 */
public record VisionRequest(String imageBase64, String mediaType, Map<String, Object> hints) {
}
