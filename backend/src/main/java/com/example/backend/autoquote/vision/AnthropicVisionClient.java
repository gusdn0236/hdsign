package com.example.backend.autoquote.vision;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.JsonValue;
import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.errors.RateLimitException;
import com.anthropic.models.messages.Base64ImageSource;
import com.anthropic.models.messages.ContentBlock;
import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.ImageBlockParam;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.TextBlockParam;
import com.anthropic.models.messages.Tool;
import com.anthropic.models.messages.ToolUseBlock;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 실제 Anthropic SDK(anthropic-java)를 forced tool-use 로 호출하는 {@link VisionClient}.
 *
 * <p><b>Forced tool-use</b>: 단일 추출 도구를 정의하고 {@code toolChoice} 를 그 도구로 강제해
 * ~99.9% 유효 JSON 을 받는다(연구 노트
 * {@code .tenet/knowledge/2026-05-30_research-claude-vision-structured-output.md}).
 * input_schema 는 tenet-test 의 4-필드 레거시({@code agent/app/vision.py})를 대체하는 rich schema 다.
 *
 * <p><b>IRON LAW</b>: API 키는 서버 env({@code ANTHROPIC_API_KEY}) 에서만 읽고, 응답·로그·예외
 * 메시지 어디에도 담지 않는다. SDK 클라이언트는 키가 실제로 필요할 때(첫 호출) 지연 생성한다 →
 * 키가 없어도 부팅(@autoquote-it)은 깨지지 않는다.
 *
 * <p>재시도/타임아웃은 하지 않는다(서비스가 전담). SDK 자체 재시도는 0 으로 꺼서 정책 카운팅이
 * 이중으로 일어나지 않게 한다. 실패는 {@link VisionClientException} 하위 타입으로 분류해 던진다.
 */
@Component
public class AnthropicVisionClient implements VisionClient {

    /** 강제 호출할 추출 도구 이름. */
    static final String TOOL_NAME = "report_work_order";

    private static final String PROMPT =
            "You are reading a single Korean signage (간판) shop work order (작업지시서). "
            + "Extract every structured field you can see and call the " + TOOL_NAME + " tool. "
            + "Use null / omit fields that are not present — never invent values. "
            + "dimensions are millimetre width/height pairs; coats is the paint coat count when shown; "
            + "qty is the per-line quantity list. Keep brand_text and notes verbatim.";

    private final String apiKey;
    private final String model;
    private final long perCallTimeoutMs;

    /** 지연 생성된 SDK 클라이언트(키가 있을 때만). */
    private volatile AnthropicClient delegate;

    public AnthropicVisionClient(
            @Value("${autoquote.vision.api-key:${ANTHROPIC_API_KEY:}}") String apiKey,
            @Value("${autoquote.vision.model:${ANTHROPIC_MODEL:claude-sonnet-4-6}}") String model,
            @Value("${autoquote.vision.timeout-ms:60000}") long perCallTimeoutMs) {
        this.apiKey = apiKey;
        this.model = model;
        this.perCallTimeoutMs = perCallTimeoutMs;
    }

    @Override
    public Map<String, Object> extract(String imageBase64, String mediaType, Map<String, Object> hints)
            throws VisionClientException {
        AnthropicClient anthropic = client();

        MessageCreateParams params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(2048)
                .addTool(extractionTool())
                .toolToolChoice(TOOL_NAME) // forced tool-use: 반드시 이 도구를 호출
                .addUserMessageOfBlockParams(buildContent(imageBase64, mediaType, hints))
                .build();

        Message message;
        try {
            message = anthropic.messages().create(params);
        } catch (RateLimitException e) {
            throw new VisionClientException.RateLimited("anthropic rate limited", e);
        } catch (AnthropicServiceException e) {
            int sc = e.statusCode();
            if (sc == 429) {
                throw new VisionClientException.RateLimited("anthropic rate limited", e);
            }
            // 5xx 및 기타 서비스 오류 → 업스트림(재시도 1회) 버킷.
            throw new VisionClientException.Upstream("anthropic service error: " + sc, e);
        } catch (AnthropicIoException e) {
            // 네트워크/소켓 타임아웃 등.
            throw new VisionClientException.Upstream("anthropic network error", e);
        } catch (RuntimeException e) {
            throw new VisionClientException.Upstream("anthropic call failed", e);
        }

        return parseToolUse(message);
    }

    /** 응답에서 forced tool_use 블록을 찾아 입력을 Map 으로 변환. 없으면 Unparsable. */
    private Map<String, Object> parseToolUse(Message message) throws VisionClientException {
        for (ContentBlock block : message.content()) {
            if (block.toolUse().isEmpty()) {
                continue;
            }
            ToolUseBlock toolUse = block.toolUse().get();
            try {
                JsonValue input = toolUse._input();
                Map<String, Object> result = input.convert(new TypeReference<Map<String, Object>>() {});
                if (result == null) {
                    throw new VisionClientException.Unparsable("tool_use input was not a JSON object", null);
                }
                return result;
            } catch (VisionClientException e) {
                throw e;
            } catch (RuntimeException e) {
                throw new VisionClientException.Unparsable("tool_use input did not match schema", e);
            }
        }
        throw new VisionClientException.Unparsable("model returned no tool_use block", null);
    }

    private List<ContentBlockParam> buildContent(String imageBase64, String mediaType, Map<String, Object> hints) {
        ImageBlockParam image = ImageBlockParam.builder()
                .source(Base64ImageSource.builder()
                        .data(imageBase64)
                        .mediaType(toMediaType(mediaType))
                        .build())
                .build();

        String text = PROMPT;
        if (hints != null && !hints.isEmpty()) {
            text = text + "\n\nContext hints (may help disambiguate): " + hints;
        }

        return List.of(
                ContentBlockParam.ofImage(image),
                ContentBlockParam.ofText(TextBlockParam.builder().text(text).build()));
    }

    private static Base64ImageSource.MediaType toMediaType(String normalized) {
        return switch (normalized) {
            case "png" -> Base64ImageSource.MediaType.IMAGE_PNG;
            case "jpeg" -> Base64ImageSource.MediaType.IMAGE_JPEG;
            case "webp" -> Base64ImageSource.MediaType.IMAGE_WEBP;
            default -> Base64ImageSource.MediaType.IMAGE_PNG;
        };
    }

    /** rich input_schema (레거시 4-필드를 대체). 모든 필드 optional — 보이는 것만 채운다. */
    private static Tool extractionTool() {
        Tool.InputSchema.Properties properties = Tool.InputSchema.Properties.builder()
                .putAdditionalProperty("client", str("Ordering client / company name"))
                .putAdditionalProperty("contact", str("Contact person or phone"))
                .putAdditionalProperty("order_date", str("Order date as written (YYYY-MM-DD if possible)"))
                .putAdditionalProperty("due_date", str("Requested due/delivery date"))
                .putAdditionalProperty("sign_types", strArray("Sign type labels, e.g. 채널, 후렉스, 아크릴"))
                .putAdditionalProperty("materials", strArray("Materials / finishes mentioned"))
                .putAdditionalProperty("dimensions", JsonValue.from(Map.of(
                        "type", "array",
                        "description", "Per-line size in mm",
                        "items", Map.of(
                                "type", "object",
                                "properties", Map.of(
                                        "w", Map.of("type", "number", "description", "width mm"),
                                        "h", Map.of("type", "number", "description", "height mm"),
                                        "coats", Map.of("type", "number", "description", "paint coats, optional")),
                                "required", List.of("w", "h")))))
                .putAdditionalProperty("brand_text", str("Brand / store name text on the sign, verbatim"))
                .putAdditionalProperty("qty", JsonValue.from(Map.of(
                        "type", "array",
                        "description", "Per-line quantity",
                        "items", Map.of("type", "number"))))
                .putAdditionalProperty("notes", str("Any other instructions, verbatim"))
                .build();

        return Tool.builder()
                .name(TOOL_NAME)
                .description("Report the structured contents of a Korean signage work order (작업지시서).")
                .inputSchema(Tool.InputSchema.builder()
                        .properties(properties)
                        .build())
                .build();
    }

    private static JsonValue str(String description) {
        return JsonValue.from(Map.of("type", "string", "description", description));
    }

    private static JsonValue strArray(String description) {
        return JsonValue.from(Map.of(
                "type", "array",
                "description", description,
                "items", Map.of("type", "string")));
    }

    /** 키가 처음 필요할 때 SDK 클라이언트를 생성(부팅 시 키 불필요). */
    private AnthropicClient client() throws VisionClientException {
        AnthropicClient local = delegate;
        if (local != null) {
            return local;
        }
        synchronized (this) {
            if (delegate == null) {
                if (apiKey == null || apiKey.isBlank()) {
                    // 키가 없으면 업스트림 불가 — 키 값 노출 없이 502 로 떨어진다.
                    throw new VisionClientException.Upstream("ANTHROPIC_API_KEY is not configured", null);
                }
                delegate = AnthropicOkHttpClient.builder()
                        .apiKey(apiKey)
                        .maxRetries(0) // 재시도는 서비스가 전담
                        .timeout(java.time.Duration.ofMillis(perCallTimeoutMs))
                        .build();
            }
            return delegate;
        }
    }
}
