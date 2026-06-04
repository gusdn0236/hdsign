package com.example.backend.autoquote.vision;

import com.anthropic.client.AnthropicClient;
import com.anthropic.core.JsonValue;
import com.anthropic.core.ObjectMappers;
import com.anthropic.core.http.Headers;
import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.InternalServerException;
import com.anthropic.errors.RateLimitException;
import com.anthropic.models.messages.Base64ImageSource;
import com.anthropic.models.messages.ContentBlock;
import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.Tool;
import com.anthropic.models.messages.ToolChoice;
import com.anthropic.services.blocking.MessageService;
import com.fasterxml.jackson.core.type.TypeReference;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.net.SocketTimeoutException;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 헤드라인 산출물({@link AnthropicVisionClient})의 결정적·키리스 단위테스트.
 *
 * <p>지금까지 이 클래스는 {@code @EnabledIfEnvironmentVariable} 라이브 스모크로만 닿았고 CI 에서는
 * 통째로 스킵됐다 → forced→auto 회귀, dimensions/coats 누락, 레거시 4-필드 회귀, tool_use 파싱·SDK
 * 예외 분류가 그린으로 통과했다. 여기서는 <b>실 API 키 없이</b> SDK 트랜스포트를 목/스텁해서:
 * <ul>
 *   <li>toolChoice 가 단일 추출 도구로 <b>강제</b>되고(auto 아님) input_schema 가 rich 10필드를 갖는지</li>
 *   <li>유효 tool_use → Map, 누락/비-object tool_use → {@link VisionClientException.Unparsable}</li>
 *   <li>SDK 예외(429/5xx/IO 타임아웃)가 정확한 {@link VisionClientException} 하위 타입으로 매핑되는지</li>
 *   <li>순수 헬퍼 {@code buildContent}/{@code toMediaType}</li>
 * </ul>
 * 를 직접 검증한다. 주입 시드 생성자로 목 {@link AnthropicClient} 를 넣으므로 OkHttp/키는 닿지 않는다.
 * 응답 {@link Message} 는 실 Anthropic 응답 모양의 JSON 을 SDK ObjectMapper 로 역직렬화해 만든다
 * (목 final 클래스 대신 실제 파싱 경로를 그대로 탄다).
 */
class AnthropicVisionClientTest {

    private static final String TINY_PNG_B64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    private static final List<String> RICH_SCHEMA_KEYS = List.of(
            "client", "contact", "order_date", "due_date", "sign_types",
            "materials", "dimensions", "brand_text", "qty", "notes");

    /** 모델이 forced tool-use 로 돌려준 것처럼 가공한 rich tool_use 입력(JSON). */
    private static final String RICH_INPUT_JSON = "{"
            + "\"client\":\"현대사인\",\"contact\":\"010-1234-5678\","
            + "\"order_date\":\"2026-06-01\",\"due_date\":\"2026-06-10\","
            + "\"sign_types\":[\"채널\",\"후렉스\"],\"materials\":[\"아크릴\"],"
            + "\"dimensions\":[{\"w\":1200,\"h\":600,\"coats\":2}],"
            + "\"brand_text\":\"맛있는 분식\",\"qty\":[1],\"notes\":\"야간 점등\"}";

    // ---- helpers ---------------------------------------------------------

    /** 목 AnthropicClient 를 주입한 클라이언트(키/OkHttp 미사용). */
    private AnthropicVisionClient clientWith(AnthropicClient delegate) {
        return new AnthropicVisionClient("", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", 60_000L, delegate);
    }

    /** delegate.messages().create(...) 를 스텁/캡처할 수 있게 묶어주는 헬퍼. */
    private static AnthropicClient mockDelegate(MessageService messages) {
        AnthropicClient delegate = mock(AnthropicClient.class);
        when(delegate.messages()).thenReturn(messages);
        return delegate;
    }

    private static Message messageFromJson(String json) {
        try {
            return ObjectMappers.jsonMapper().readValue(json, Message.class);
        } catch (Exception e) {
            throw new RuntimeException("test fixture parse failed", e);
        }
    }

    /** tool_use 블록 하나(input=주어진 JSON)를 담은 assistant 응답 Message. */
    private static Message toolUseMessage(String inputJson) {
        return messageFromJson("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\","
                + "\"model\":\"claude-sonnet-4-6\",\"stop_reason\":\"tool_use\",\"stop_sequence\":null,"
                + "\"content\":[{\"type\":\"text\",\"text\":\"ok\"},"
                + "{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"report_work_order\",\"input\":" + inputJson + "}],"
                + "\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}");
    }

    /** tool_use 블록이 전혀 없는(텍스트만) 응답 Message. */
    private static Message textOnlyMessage() {
        return messageFromJson("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\","
                + "\"model\":\"claude-sonnet-4-6\",\"stop_reason\":\"end_turn\",\"stop_sequence\":null,"
                + "\"content\":[{\"type\":\"text\",\"text\":\"no tool here\"}],"
                + "\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}");
    }

    // ---- forced tool-use + rich schema ----------------------------------

    @Test
    void extractionTool_isForcedSingleTool_withAll10RichProperties() {
        Tool tool = AnthropicVisionClient.extractionTool();

        assertThat(tool.name()).isEqualTo("report_work_order");
        Map<String, JsonValue> props = tool.inputSchema().properties().orElseThrow()._additionalProperties();
        // rich schema (레거시 agent/app/vision.py 의 4-필드를 대체) — 정확히 이 10개.
        assertThat(props.keySet()).containsExactlyInAnyOrderElementsOf(RICH_SCHEMA_KEYS);
    }

    @Test
    void dimensionsSchema_carriesWidthHeightAndOptionalCoats() {
        Tool tool = AnthropicVisionClient.extractionTool();
        Map<String, JsonValue> props = tool.inputSchema().properties().orElseThrow()._additionalProperties();

        Map<String, Object> dimensions =
                props.get("dimensions").convert(new TypeReference<Map<String, Object>>() {});
        @SuppressWarnings("unchecked")
        Map<String, Object> items = (Map<String, Object>) dimensions.get("items");
        @SuppressWarnings("unchecked")
        Map<String, Object> itemProps = (Map<String, Object>) items.get("properties");

        assertThat(itemProps.keySet()).contains("w", "h", "coats");
        @SuppressWarnings("unchecked")
        List<String> required = (List<String>) items.get("required");
        assertThat(required).containsExactlyInAnyOrder("w", "h");
    }

    @Test
    void buildParams_forcesToolChoiceToExtractionTool_notAuto() {
        MessageCreateParams params = clientWith(mock(AnthropicClient.class))
                .buildParams(TINY_PNG_B64, "png", null);

        ToolChoice choice = params.toolChoice().orElseThrow();
        assertThat(choice.isTool()).isTrue();      // forced
        assertThat(choice.isAuto()).isFalse();     // NOT auto (회귀 가드)
        assertThat(choice.asTool().name()).isEqualTo("report_work_order");

        Tool sent = params.tools().orElseThrow().get(0).tool().orElseThrow();
        assertThat(sent.inputSchema().properties().orElseThrow()._additionalProperties().keySet())
                .containsExactlyInAnyOrderElementsOf(RICH_SCHEMA_KEYS);
    }

    // ---- 글자읽기(read_text) 분기 ----------------------------------------

    @Test
    void readTextTool_isSingleTextField() {
        Tool tool = AnthropicVisionClient.readTextTool();

        assertThat(tool.name()).isEqualTo("report_text");
        assertThat(tool.inputSchema().properties().orElseThrow()._additionalProperties().keySet())
                .containsExactly("text");
    }

    @Test
    void isReadTextMode_trueOnlyForReadTextHint() {
        assertThat(AnthropicVisionClient.isReadTextMode(null)).isFalse();
        assertThat(AnthropicVisionClient.isReadTextMode(Map.of())).isFalse();
        assertThat(AnthropicVisionClient.isReadTextMode(Map.of("mode", "read_text"))).isTrue();
        assertThat(AnthropicVisionClient.isReadTextMode(Map.of("mode", "other"))).isFalse();
    }

    @Test
    void buildParams_readTextMode_forcesReportTextTool_withCountModel() {
        // 글자읽기 모드 → report_text 도구로 강제 + 저렴한(haiku) count 모델 사용.
        AnthropicVisionClient c = new AnthropicVisionClient(
                "", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", 60_000L, mock(AnthropicClient.class));
        MessageCreateParams params = c.buildParams(TINY_PNG_B64, "jpeg", Map.of("mode", "read_text"));

        ToolChoice choice = params.toolChoice().orElseThrow();
        assertThat(choice.isTool()).isTrue();
        assertThat(choice.asTool().name()).isEqualTo("report_text");

        Tool sent = params.tools().orElseThrow().get(0).tool().orElseThrow();
        assertThat(sent.inputSchema().properties().orElseThrow()._additionalProperties().keySet())
                .containsExactly("text");
    }

    @Test
    void buildParams_default_stillUsesExtractionTool() {
        // 힌트가 read_text 가 아니면 기존 전체추출(report_work_order) 경로 유지(회귀 가드).
        MessageCreateParams params = clientWith(mock(AnthropicClient.class))
                .buildParams(TINY_PNG_B64, "png", Map.of("거래처", "현대사인"));
        assertThat(params.toolChoice().orElseThrow().asTool().name()).isEqualTo("report_work_order");
    }

    /** 스텁 등가물(라이브 스모크 보강): extract() 가 forced 파라미터를 실제로 보내고 rich-schema Map 을 돌려준다. */
    @Test
    void extract_sendsForcedToolUse_andReturnsRichSchemaMap() throws Exception {
        MessageService messages = mock(MessageService.class);
        ArgumentCaptor<MessageCreateParams> sent = ArgumentCaptor.forClass(MessageCreateParams.class);
        when(messages.create(sent.capture())).thenReturn(toolUseMessage(RICH_INPUT_JSON));

        Map<String, Object> out = clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null);

        // 실제 호출에 실린 파라미터가 forced tool-use 였는지.
        assertThat(sent.getValue().toolChoice().orElseThrow().isTool()).isTrue();
        // 돌려준 Map 이 4-필드가 아니라 rich-schema 키를 실제로 운반하는지(스펙: result!=null 그 이상).
        assertThat(out).containsKeys("client", "sign_types", "dimensions", "qty", "brand_text", "notes");
        assertThat(out.get("client")).isEqualTo("현대사인");
        @SuppressWarnings("unchecked")
        List<String> signTypes = (List<String>) out.get("sign_types");
        assertThat(signTypes).contains("채널");
    }

    // ---- tool_use parse --------------------------------------------------

    @Test
    void parseToolUse_validBlock_skipsNonToolBlocks_andReturnsMap() throws Exception {
        // content = [text, tool_use] → 텍스트 블록은 건너뛰고 tool_use 를 파싱.
        Map<String, Object> out = AnthropicVisionClient.parseToolUse(toolUseMessage(RICH_INPUT_JSON).content());

        assertThat(out).containsKeys(RICH_SCHEMA_KEYS.toArray(new String[0]));
    }

    @Test
    void parseToolUse_missingToolUseBlock_throwsUnparsable() {
        List<ContentBlock> textOnly = textOnlyMessage().content();
        VisionClientException.Unparsable ex = catchThrowableOfType(
                () -> AnthropicVisionClient.parseToolUse(textOnly),
                VisionClientException.Unparsable.class);
        assertThat(ex).isNotNull();
    }

    @Test
    void parseToolUse_nonObjectInput_throwsUnparsable() {
        // tool_use 입력이 JSON object 가 아니라 배열이면 스키마 매핑 실패 → Unparsable(서비스가 422 로 매핑).
        List<ContentBlock> malformed = toolUseMessage("[1,2,3]").content();
        VisionClientException.Unparsable ex = catchThrowableOfType(
                () -> AnthropicVisionClient.parseToolUse(malformed),
                VisionClientException.Unparsable.class);
        assertThat(ex).isNotNull();
    }

    @Test
    void parseToolUse_nullInput_throwsUnparsable() {
        // tool_use 입력이 JSON null 이면 object 가 아님 → Unparsable.
        List<ContentBlock> nullInput = toolUseMessage("null").content();
        VisionClientException.Unparsable ex = catchThrowableOfType(
                () -> AnthropicVisionClient.parseToolUse(nullInput),
                VisionClientException.Unparsable.class);
        assertThat(ex).isNotNull();
    }

    // ---- SDK exception -> VisionClientException mapping ------------------

    @Test
    void extract_rateLimitException_mapsToRateLimited_andStillSendsForcedToolUse() {
        RateLimitException sdk = RateLimitException.builder()
                .headers(Headers.builder().build())
                .body(JsonValue.from(Map.of("type", "error")))
                .build();
        MessageService messages = mock(MessageService.class);
        ArgumentCaptor<MessageCreateParams> sent = ArgumentCaptor.forClass(MessageCreateParams.class);
        when(messages.create(sent.capture())).thenThrow(sdk);

        assertThatThrownBy(() -> clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null))
                .isInstanceOf(VisionClientException.RateLimited.class);
        // 실 extract() 경로가 forced tool-use 파라미터를 보냈는지(예외 직전 캡처).
        assertThat(sent.getValue().toolChoice().orElseThrow().isTool()).isTrue();
    }

    @Test
    void extract_serviceException429_mapsToRateLimited() {
        // RateLimitException 이 아닌 일반 서비스 예외라도 statusCode==429 면 RateLimited 로 분류돼야 한다.
        InternalServerException sdk = InternalServerException.builder()
                .statusCode(429)
                .headers(Headers.builder().build())
                .body(JsonValue.from(Map.of("type", "error")))
                .build();
        MessageService messages = mock(MessageService.class);
        when(messages.create(any(MessageCreateParams.class))).thenThrow(sdk);

        assertThatThrownBy(() -> clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null))
                .isInstanceOf(VisionClientException.RateLimited.class);
    }

    @Test
    void extract_serviceException5xx_mapsToUpstream() {
        InternalServerException sdk = InternalServerException.builder()
                .statusCode(503)
                .headers(Headers.builder().build())
                .body(JsonValue.from(Map.of("type", "error")))
                .build();
        MessageService messages = mock(MessageService.class);
        when(messages.create(any(MessageCreateParams.class))).thenThrow(sdk);

        assertThatThrownBy(() -> clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null))
                .isInstanceOf(VisionClientException.Upstream.class);
    }

    @Test
    void extract_ioException_socketTimeout_mapsToUpstream() {
        AnthropicIoException sdk = new AnthropicIoException("read timed out", new SocketTimeoutException("timeout"));
        MessageService messages = mock(MessageService.class);
        when(messages.create(any(MessageCreateParams.class))).thenThrow(sdk);

        assertThatThrownBy(() -> clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null))
                .isInstanceOf(VisionClientException.Upstream.class);
    }

    @Test
    void extract_unexpectedRuntime_mapsToUpstream() {
        MessageService messages = mock(MessageService.class);
        when(messages.create(any(MessageCreateParams.class))).thenThrow(new IllegalStateException("boom"));

        assertThatThrownBy(() -> clientWith(mockDelegate(messages)).extract(TINY_PNG_B64, "png", null))
                .isInstanceOf(VisionClientException.Upstream.class);
    }

    @Test
    void extract_noKeyAndNoDelegate_throwsUpstream_withoutLeakingKey() {
        // 주입 delegate 없음 + 키 공백 → 키 노출 없이 Upstream(서비스가 502 로 매핑). 부팅은 여전히 키 불필요.
        AnthropicVisionClient noKey =
                new AnthropicVisionClient("", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", 60_000L);

        VisionClientException ex = catchThrowableOfType(
                () -> noKey.extract(TINY_PNG_B64, "png", null), VisionClientException.class);

        assertThat(ex).isInstanceOf(VisionClientException.Upstream.class);
        assertThat(ex.getMessage()).doesNotContain("sk-"); // IRON LAW: 어떤 키 잔재도 없음
    }

    // ---- pure helpers ----------------------------------------------------

    @Test
    void toMediaType_mapsKnownTypes_andDefaultsToPng() {
        assertThat(AnthropicVisionClient.toMediaType("png")).isEqualTo(Base64ImageSource.MediaType.IMAGE_PNG);
        assertThat(AnthropicVisionClient.toMediaType("jpeg")).isEqualTo(Base64ImageSource.MediaType.IMAGE_JPEG);
        assertThat(AnthropicVisionClient.toMediaType("webp")).isEqualTo(Base64ImageSource.MediaType.IMAGE_WEBP);
        // 알 수 없는 타입은 png 로 안전 폴백(컨트롤러가 이미 비-이미지를 400 으로 거른 뒤라 도달 시 무해).
        assertThat(AnthropicVisionClient.toMediaType("tiff")).isEqualTo(Base64ImageSource.MediaType.IMAGE_PNG);
    }

    @Test
    void buildContent_carriesImageAndPrompt_andAppendsHints() {
        List<ContentBlockParam> noHints = AnthropicVisionClient.buildContent(TINY_PNG_B64, "png", null);
        assertThat(noHints).hasSize(2);
        assertThat(noHints.get(0).isImage()).isTrue();
        String prompt = noHints.get(1).asText().text();
        assertThat(prompt).contains(AnthropicVisionClient.TOOL_NAME);
        assertThat(prompt).doesNotContain("Context hints");

        List<ContentBlockParam> withHints =
                AnthropicVisionClient.buildContent(TINY_PNG_B64, "jpeg", Map.of("거래처", "현대사인"));
        assertThat(withHints.get(1).asText().text()).contains("Context hints").contains("현대사인");
    }
}
