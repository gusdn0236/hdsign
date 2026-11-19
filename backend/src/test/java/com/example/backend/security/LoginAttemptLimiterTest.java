package com.example.backend.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.*;

class LoginAttemptLimiterTest {

    private static MockHttpServletRequest from(String xff) {
        MockHttpServletRequest r = new MockHttpServletRequest();
        if (xff != null) r.addHeader("X-Forwarded-For", xff);
        return r;
    }

    @Test
    void locksAfterMaxFailuresPerUserEvenAcrossIps() {
        LoginAttemptLimiter l = new LoginAttemptLimiter();
        for (int i = 0; i < LoginAttemptLimiter.MAX_FAILURES - 1; i++) {
            l.recordFailure("admin", "boss", from("10.0.0." + i));
        }
        assertEquals(0, l.lockedMinutes("admin", "boss", from("10.0.1.1")));
        l.recordFailure("admin", "boss", from("10.0.0.99"));
        assertTrue(l.lockedMinutes("admin", "BOSS", from("10.0.1.1")) > 0);
        // 다른 범위(거래처)는 별개
        assertEquals(0, l.lockedMinutes("client", "boss", from("10.0.1.1")));
    }

    @Test
    void locksPerIpAcrossUsernames() {
        LoginAttemptLimiter l = new LoginAttemptLimiter();
        for (int i = 0; i < LoginAttemptLimiter.MAX_FAILURES; i++) {
            l.recordFailure("client", "user" + i, from("1.2.3.4"));
        }
        assertTrue(l.lockedMinutes("client", "someone-else", from("1.2.3.4")) > 0);
        assertEquals(0, l.lockedMinutes("client", "someone-else", from("5.6.7.8")));
    }

    @Test
    void successClearsCounters() {
        LoginAttemptLimiter l = new LoginAttemptLimiter();
        for (int i = 0; i < LoginAttemptLimiter.MAX_FAILURES - 1; i++) {
            l.recordFailure("admin", "boss", from("1.1.1.1"));
        }
        l.recordSuccess("admin", "boss", from("1.1.1.1"));
        l.recordFailure("admin", "boss", from("1.1.1.1"));
        assertEquals(0, l.lockedMinutes("admin", "boss", from("1.1.1.1")));
    }

    @Test
    void spoofedLeftmostForwardedForIsIgnored() {
        assertEquals("9.9.9.9", LoginAttemptLimiter.clientIp(from("1.1.1.1, 9.9.9.9")));
        assertEquals("127.0.0.1", LoginAttemptLimiter.clientIp(from(null)));
    }
}
