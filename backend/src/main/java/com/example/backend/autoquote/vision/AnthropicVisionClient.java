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
import org.springframework.beans.factory.annotation.Autowired;
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

    /** @slice 글자수: 박스 친 영역의 간판 글자만 읽어 글자수 계산(charCount)에 쓰는 경량 도구 이름. */
    static final String READ_TEXT_TOOL = "report_text";

    private static final String PROMPT =
            "You are reading a single Korean signage (간판) shop work order (작업지시서). "
            + "Extract every structured field you can see and call the " + TOOL_NAME + " tool. "
            + "Use null / omit fields that are not present — never invent values. "
            + "dimensions are millimetre width/height pairs; coats is the paint coat count when shown; "
            + "qty is the per-line quantity list. Keep brand_text and notes verbatim.";

    /**
     * 글자읽기 프롬프트 — 사용자가 지시서에서 박스로 오려낸 영역만 보고, 제작될 <b>간판 글자</b>만
     * verbatim 으로 옮긴다. 치수/재질/가격/지시문은 제외(글자수 산정에 잡음). 글자수 세기는 프론트가
     * {@code charCount} 로 하므로 여기서는 글자 자체만 정확히 돌려주면 된다.
     */
    private static final String READ_TEXT_PROMPT =
            "This image is a cropped region of a Korean signage (간판) work order. "
            + "Transcribe ONLY the sign lettering (간판 글자) that will be fabricated — the actual "
            + "Korean / English characters and digits shown, verbatim, in natural reading order. "
            + "Join multiple lines with a single space. Do NOT include measurements, dimensions, "
            + "material names, prices, or instructions — only the letters to be produced. "
            + "\n\n"
            + "READ HANGUL WITH CARE. The lettering may be thin, faint, or low-contrast. Each Korean "
            + "syllable is a block of initial consonant + vowel + optional final consonant (받침); read "
            + "all three parts of EVERY block. Distinguish look-alike jamo precisely: vowels ㅓ/ㅕ, ㅏ/ㅑ, "
            + "ㅗ/ㅛ, ㅜ/ㅠ, ㅐ/ㅔ, ㅡ/ㅢ; final consonants ㄹ/ㅌ/ㄷ, ㅁ/ㅂ, ㄴ/ㄱ, ㅇ/ㅎ. Count vowel strokes "
            + "(e.g. ㅓ has one short stroke, ㅕ has two) and check the 받침 shape carefully. "
            + "Read EXACTLY the characters drawn, one syllable block at a time, even if they form a fragment, "
            + "a partial word, or a meaningless string — sign lettering is very often partial or non-dictionary "
            + "text. Do NOT 'correct' the reading toward a real or natural Korean word, and do NOT guess, "
            + "auto-complete, or substitute a plausible word. If a stroke is genuinely unclear, choose the jamo "
            + "that best matches the DRAWN shape — never the one that merely forms a real word. Transcribe only "
            + "what is actually present; never invent or auto-complete characters that are not there. "
            + "If there is no legible lettering, return an empty string. Call the " + READ_TEXT_TOOL + " tool.";

    private final String apiKey;
    private final String model;
    /** 글자읽기 전용 모델 — 조각/비단어 정확도 평가 위해 Sonnet 으로 상향(2026-06, 한 달 시범).
     *  사용량 20~30건/일 × 1~5회면 월 수천~1.5만원 수준. 비용 부담되면 count-model 을 다시
     *  claude-haiku-4-5-20251001 로(코드 기본값 또는 env autoquote.vision.count-model). */
    private final String countModel;
    private final long perCallTimeoutMs;

    /** 지연 생성된 SDK 클라이언트(키가 있을 때만). */
    private volatile AnthropicClient delegate;

    @Autowired
    public AnthropicVisionClient(
            @Value("${autoquote.vision.api-key:${ANTHROPIC_API_KEY:}}") String apiKey,
            @Value("${autoquote.vision.model:${ANTHROPIC_MODEL:claude-sonnet-4-6}}") String model,
            @Value("${autoquote.vision.count-model:claude-sonnet-4-6}") String countModel,
            @Value("${autoquote.vision.timeout-ms:60000}") long perCallTimeoutMs) {
        this(apiKey, model, countModel, perCallTimeoutMs, null);
    }

    /**
     * 주입 시드용(테스트 전용) 생성자. 이미 만들어진 SDK {@link AnthropicClient}(예: 목)를 직접 주입하면
     * {@link #client()} 는 OkHttp 빌드/키를 일절 건드리지 않고 그것을 그대로 쓴다 → 실 키 없이 forced
     * tool-use·파싱·예외 매핑 전 구간을 결정적으로 단위테스트할 수 있다(스펙 'Vision proxy' 커버리지).
     * {@code injectedDelegate == null} 이면 운영과 동일하게 첫 호출 시 키로 OkHttp 클라이언트를 지연 생성한다.
     */
    AnthropicVisionClient(
            String apiKey, String model, String countModel, long perCallTimeoutMs, AnthropicClient injectedDelegate) {
        this.apiKey = apiKey;
        this.model = model;
        this.countModel = countModel;
        this.perCallTimeoutMs = perCallTimeoutMs;
        this.delegate = injectedDelegate;
    }

    @Override
    public Map<String, Object> extract(String imageBase64, String mediaType, Map<String, Object> hints)
            throws VisionClientException {
        AnthropicClient anthropic = client();

        MessageCreateParams params = buildParams(imageBase64, mediaType, hints);

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

        return parseToolUse(message.content());
    }

    /**
     * forced tool-use 메시지 파라미터를 구성한다(스펙: 단일 추출 도구로 toolChoice 를 <b>강제</b>).
     * 순수 함수라 실 키 없이 단위테스트로 toolChoice·rich input_schema 를 검증할 수 있다.
     */
    MessageCreateParams buildParams(String imageBase64, String mediaType, Map<String, Object> hints) {
        if (isReadTextMode(hints)) {
            // 글자읽기 경로 — 경량 도구 + Haiku. mode 힌트는 프롬프트에 섞지 않는다(null 전달).
            return MessageCreateParams.builder()
                    .model(countModel)
                    .maxTokens(1024)
                    .addTool(readTextTool())
                    .toolToolChoice(READ_TEXT_TOOL) // forced tool-use
                    .addUserMessageOfBlockParams(buildContentWithPrompt(imageBase64, mediaType, null, READ_TEXT_PROMPT))
                    .build();
        }
        return MessageCreateParams.builder()
                .model(model)
                .maxTokens(2048)
                .addTool(extractionTool())
                .toolToolChoice(TOOL_NAME) // forced tool-use: 반드시 이 도구를 호출(auto 아님)
                .addUserMessageOfBlockParams(buildContent(imageBase64, mediaType, hints))
                .build();
    }

    /** {@code hints.mode == "read_text"} 면 글자읽기(경량/Haiku) 경로로 분기한다. */
    static boolean isReadTextMode(Map<String, Object> hints) {
        return hints != null && "read_text".equals(String.valueOf(hints.get("mode")));
    }

    /** 응답 컨텐츠에서 forced tool_use 블록을 찾아 입력을 Map 으로 변환. 없거나 비-object 면 Unparsable. */
    static Map<String, Object> parseToolUse(List<ContentBlock> content) throws VisionClientException {
        for (ContentBlock block : content) {
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

    static List<ContentBlockParam> buildContent(String imageBase64, String mediaType, Map<String, Object> hints) {
        return buildContentWithPrompt(imageBase64, mediaType, hints, PROMPT);
    }

    /** 이미지 + (기본 프롬프트 ± 컨텍스트 힌트) 컨텐츠 블록. 전체추출/글자읽기가 프롬프트만 달리해 공유한다. */
    static List<ContentBlockParam> buildContentWithPrompt(
            String imageBase64, String mediaType, Map<String, Object> hints, String basePrompt) {
        ImageBlockParam image = ImageBlockParam.builder()
                .source(Base64ImageSource.builder()
                        .data(imageBase64)
                        .mediaType(toMediaType(mediaType))
                        .build())
                .build();

        String text = basePrompt;
        if (hints != null && !hints.isEmpty()) {
            text = text + "\n\nContext hints (may help disambiguate): " + hints;
        }

        return List.of(
                ContentBlockParam.ofImage(image),
                ContentBlockParam.ofText(TextBlockParam.builder().text(text).build()));
    }

    static Base64ImageSource.MediaType toMediaType(String normalized) {
        return switch (normalized) {
            case "png" -> Base64ImageSource.MediaType.IMAGE_PNG;
            case "jpeg" -> Base64ImageSource.MediaType.IMAGE_JPEG;
            case "webp" -> Base64ImageSource.MediaType.IMAGE_WEBP;
            default -> Base64ImageSource.MediaType.IMAGE_PNG;
        };
    }

    /** rich input_schema (레거시 4-필드를 대체). 모든 필드 optional — 보이는 것만 채운다. */
    static Tool extractionTool() {
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

    /**
     * 글자읽기 도구 — 박스 영역의 간판 글자만 verbatim 으로 돌려준다(글자수는 프론트 {@code charCount} 가 센다).
     * 단일 {@code text} 필드라 forced tool-use 로 거의 항상 유효 JSON 을 받는다.
     */
    static Tool readTextTool() {
        Tool.InputSchema.Properties properties = Tool.InputSchema.Properties.builder()
                .putAdditionalProperty("text", str("The exact sign lettering visible, verbatim, multiple lines joined by a space"))
                .build();

        return Tool.builder()
                .name(READ_TEXT_TOOL)
                .description("Report the verbatim lettering (글자) to be fabricated from a cropped signage work-order region.")
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
