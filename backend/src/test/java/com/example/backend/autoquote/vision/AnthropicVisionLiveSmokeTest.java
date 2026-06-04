package com.example.backend.autoquote.vision;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 실 API 키가 있을 때만 도는 라이브 스모크(실제 Claude 호출). CI 에는 키가 없으므로 자동 스킵된다
 * ({@link EnabledIfEnvironmentVariable}). 키는 서버 env({@code ANTHROPIC_API_KEY})에서만 읽는다(IRON LAW).
 *
 * 목적: forced tool-use 경로가 실제로 구조화 Map 을 돌려주는지(파싱 가능) 한 번 확인.
 * 작은 1x1 PNG 라 대부분 필드는 null 이지만 tool_use 자체는 성립해야 한다.
 */
@EnabledIfEnvironmentVariable(named = "ANTHROPIC_API_KEY", matches = ".+")
class AnthropicVisionLiveSmokeTest {

    private static final String TINY_PNG_B64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    @Test
    void liveExtract_returnsStructuredMap() throws Exception {
        String key = System.getenv("ANTHROPIC_API_KEY");
        String model = System.getenv().getOrDefault("ANTHROPIC_MODEL", "claude-sonnet-4-6");

        String countModel = System.getenv().getOrDefault("ANTHROPIC_COUNT_MODEL", "claude-haiku-4-5-20251001");
        AnthropicVisionClient client = new AnthropicVisionClient(key, model, countModel, 60_000L);

        Map<String, Object> result = client.extract(TINY_PNG_B64, "png", null);

        assertThat(result).isNotNull();
    }
}
