package com.example.backend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 알림 문구는 현장 직원이 실제로 보는 유일한 결과물이라, 제목·본문 조립 규칙을 못박아 둔다.
 * (푸시 발송 자체는 {@link WebPushServiceTest} 가 담당)
 */
class WorksheetPushPayloadTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final WorksheetPushNotifier notifier = new WorksheetPushNotifier(null, null, null);

    private JsonNode payload(String orderNumber, String label, String changeNote) throws Exception {
        String json = ReflectionTestUtils.invokeMethod(notifier, "buildPayload", orderNumber, label, changeNote);
        return MAPPER.readTree(json);
    }

    @Test
    @DisplayName("제목은 상호명 기준, 본문은 변경 메모 그대로")
    void showsCompanyNameAndChangeNote() throws Exception {
        JsonNode data = payload("HD-1234", "○○기획", "간판 규격 3000x600 으로 수정");

        assertEquals("○○기획 지시서 내용이 변경되었습니다", data.get("title").asText());
        assertEquals("간판 규격 3000x600 으로 수정", data.get("body").asText());
        assertEquals("/m/worksheets/HD-1234", data.get("url").asText());
        assertEquals("HD-1234", data.get("orderNumber").asText());
    }

    @Test
    @DisplayName("메모 없이 재업로드하면 본문은 안내 문구로 폴백 — 알림 자체는 나가야 한다")
    void fallsBackWhenNoteMissing() throws Exception {
        assertEquals("지시서를 다시 확인해주세요", payload("HD-1", "○○기획", null).get("body").asText());
        assertEquals("지시서를 다시 확인해주세요", payload("HD-1", "○○기획", "   ").get("body").asText());
    }

    @Test
    @DisplayName("여러 줄 메모는 한 줄로 눌러 담는다 — 알림 본문은 줄바꿈을 살려주지 않는다")
    void flattensWhitespace() throws Exception {
        JsonNode data = payload("HD-1", "○○기획", "  규격 변경\n\n색상 변경  ");
        assertEquals("규격 변경 색상 변경", data.get("body").asText());
    }

    @Test
    @DisplayName("긴 메모는 잘라서 싣는다 — 푸시 페이로드에 4KB 제한이 있다")
    void truncatesLongNote() throws Exception {
        String body = payload("HD-1", "○○기획", "가".repeat(500)).get("body").asText();

        assertEquals(201, body.length(), "200자 + 말줄임표여야 한다");
        assertTrue(body.endsWith("…"), "잘렸다는 표시가 없다: " + body);
    }

    @Test
    @DisplayName("상호명을 못 읽으면 주문번호가 제목에 들어간다(resolveLabel 폴백 결과)")
    void usesOrderNumberWhenCompanyNameMissing() throws Exception {
        assertEquals("HD-1234 지시서 내용이 변경되었습니다", payload("HD-1234", "HD-1234", null).get("title").asText());
    }
}
