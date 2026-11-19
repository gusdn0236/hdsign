package com.example.backend.security;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 로그인 무차별 대입(비밀번호 계속 바꿔 넣기) 방어 — 관리자·거래처 로그인 공용.
 *
 * 실패 횟수를 두 기준으로 따로 센다:
 *  - IP 별: 한 곳에서 여러 아이디를 두드리는 공격 차단
 *  - 아이디 별: 여러 IP 로 나눠 한 계정을 두드리는 공격 차단
 * 어느 쪽이든 WINDOW 안에 MAX_FAILURES 번 틀리면 LOCK 동안 로그인 자체를 거부한다(맞는 비번이어도).
 * 성공하면 그 아이디·IP 카운터를 비운다.
 *
 * 사무실 PC 들은 같은 공인 IP 를 공유하므로 기준을 넉넉하게(10회) 잡았다 — 직원 오타로는 안 걸린다.
 * 메모리 보관(서버 1대 운영). 재배포하면 초기화되는 건 의도된 단순함.
 */
@Slf4j
@Component
public class LoginAttemptLimiter {

    static final int MAX_FAILURES = 10;
    static final long WINDOW_MS = 15 * 60 * 1000L;
    static final long LOCK_MS = 15 * 60 * 1000L;

    private static final class Counter {
        int failures;
        long windowStart;
        long lockedUntil;
    }

    private final Map<String, Counter> counters = new ConcurrentHashMap<>();

    /** 잠겨 있으면 남은 분(1 이상), 아니면 0. */
    public long lockedMinutes(String scope, String username, HttpServletRequest request) {
        long now = System.currentTimeMillis();
        long until = Math.max(
                lockedUntil(key(scope, "ip", clientIp(request)), now),
                lockedUntil(key(scope, "user", normalize(username)), now));
        if (until <= now) return 0;
        return Math.max(1, (until - now + 59_999) / 60_000);
    }

    public void recordFailure(String scope, String username, HttpServletRequest request) {
        long now = System.currentTimeMillis();
        String ip = clientIp(request);
        bump(key(scope, "ip", ip), now);
        bump(key(scope, "user", normalize(username)), now);
        log.warn("로그인 실패 [{}] user={} ip={}", scope, normalize(username), ip);
        if (counters.size() > 10_000) purge(now);
    }

    public void recordSuccess(String scope, String username, HttpServletRequest request) {
        counters.remove(key(scope, "ip", clientIp(request)));
        counters.remove(key(scope, "user", normalize(username)));
    }

    public String lockMessage(long minutes) {
        return "로그인 실패가 너무 많아 잠시 잠겼습니다. 약 " + minutes + "분 뒤에 다시 시도해주세요.";
    }

    private long lockedUntil(String key, long now) {
        Counter c = counters.get(key);
        if (c == null) return 0;
        synchronized (c) {
            return c.lockedUntil > now ? c.lockedUntil : 0;
        }
    }

    private void bump(String key, long now) {
        Counter c = counters.computeIfAbsent(key, k -> new Counter());
        synchronized (c) {
            if (now - c.windowStart > WINDOW_MS) {
                c.windowStart = now;
                c.failures = 0;
            }
            c.failures++;
            if (c.failures >= MAX_FAILURES) {
                c.lockedUntil = now + LOCK_MS;
                c.failures = 0;
                c.windowStart = now;
                log.warn("로그인 잠금 {} ({}분)", key, LOCK_MS / 60_000);
            }
        }
    }

    private void purge(long now) {
        counters.entrySet().removeIf(e -> {
            Counter c = e.getValue();
            synchronized (c) {
                return c.lockedUntil <= now && now - c.windowStart > WINDOW_MS;
            }
        });
    }

    private static String key(String scope, String kind, String value) {
        return scope + "|" + kind + "|" + value;
    }

    private static String normalize(String username) {
        return username == null ? "" : username.trim().toLowerCase();
    }

    /**
     * Railway 프록시 뒤라 getRemoteAddr 는 프록시 IP 다. X-Forwarded-For 의 맨 오른쪽 값은
     * Railway 프록시가 직접 본 접속 IP 라 공격자가 헤더를 꾸며도 바뀌지 않는다(왼쪽 값들은 조작 가능).
     */
    static String clientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            String[] parts = xff.split(",");
            String last = parts[parts.length - 1].trim();
            if (!last.isEmpty()) return last;
        }
        return request.getRemoteAddr();
    }
}
