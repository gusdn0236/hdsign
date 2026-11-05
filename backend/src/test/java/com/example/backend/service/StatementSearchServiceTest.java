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
    void normIgnoresSpaceAndCase() {
        assertEquals("TOILET", StatementSearchService.norm(" toi let "));
        assertEquals("아크릴5T", StatementSearchService.norm("아크릴 5t"));
        assertNull(StatementSearchService.parseSpec("  "));
    }
}
