package com.example.backend.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class StatementSearchServiceTest {

    private static boolean m(String row, String q) {
        return StatementSearchService.specMatches(row, StatementSearchService.parseSpec(q));
    }

    @Test
    void specPairMatchesAnyNotationAndSwapped() {
        assertTrue(m("500*100", "500*100"));
        assertTrue(m("500x100", "500 100"));
        assertTrue(m("500 X 100", "500*100"));
        assertTrue(m("100*500", "500*100"));
        assertTrue(m("H:30 / 500×100", "100x500"));
        assertFalse(m("500*120", "500*100"));
        assertFalse(m("5000*100", "500*100"));
        assertFalse(m("", "500*100"));
    }

    @Test
    void specSingleNumber() {
        assertTrue(m("h:88", "88"));
        assertTrue(m("600*88", "88"));
        assertFalse(m("880", "88"));
    }

    @Test
    void matchRowsSameRowAndRules() {
        String json = "{\"grid\":[{\"품목코드\":\"아크릴5T\",\"품목\":\"육바연 로고\",\"규격\":\"500*100\",\"단가\":\"15,000\"},"
                + "{\"품목코드\":\"갈바후광\",\"품목\":\"포장전용\",\"규격\":\"300*200\"}]}";
        var sp = java.util.List.of(StatementSearchService.parseSpec("100x500"));
        assertEquals(1, StatementSearchService.matchRows(json, java.util.List.of("아크릴5T"), java.util.List.of(), sp).size());
        // 코드는 맞지만 규격은 다른 행 → 같은 행이 아니므로 0
        assertEquals(0, StatementSearchService.matchRows(json, java.util.List.of("갈바후광"), java.util.List.of(), sp).size());
        // 코드 OR
        assertEquals(2, StatementSearchService.matchRows(json, java.util.List.of("아크릴5T", "갈바후광"), java.util.List.of(), java.util.List.of()).size());
        // 텍스트 AND (공백 무시)
        assertEquals(1, StatementSearchService.matchRows(json, java.util.List.of(), java.util.List.of("육바연", "로고"), java.util.List.of()).size());
        assertEquals(0, StatementSearchService.matchRows(json, java.util.List.of(), java.util.List.of("육바연", "포장"), java.util.List.of()).size());
    }

    @Test
    void normIgnoresSpaceAndCase() {
        assertEquals("TOILET", StatementSearchService.norm(" toi let "));
        assertEquals("아크릴5T", StatementSearchService.norm("아크릴 5t"));
        assertNull(StatementSearchService.parseSpec("  "));
    }
}
