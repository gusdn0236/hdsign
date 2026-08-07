package com.example.backend.controller;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * 이 엔드포인트의 존재 이유가 "배포가 반영됐는지 확인" 이라, 값이 틀리면 확인 수단 자체가
 * 거짓말을 하게 된다. 짧은 해시 변환과 로컬 폴백을 못박아 둔다.
 */
class BuildInfoControllerTest {

    private Map<String, String> call(String sha, String branch) {
        BuildInfoController controller = new BuildInfoController();
        ReflectionTestUtils.setField(controller, "commitSha", sha);
        ReflectionTestUtils.setField(controller, "branch", branch);
        return controller.buildInfo().getBody();
    }

    @Test
    @DisplayName("Railway 커밋 SHA 는 앞 8자리로 줄여서 준다 — git log --oneline 과 맞춰 비교하려고")
    void shortensCommitSha() {
        Map<String, String> info = call("eb1be1c967fdfbff2397889208917f62af7ec17e", "master");

        assertNotNull(info);
        assertEquals("eb1be1c9", info.get("commit"));
        assertEquals("master", info.get("branch"));
    }

    @Test
    @DisplayName("로컬 실행처럼 Railway 변수가 없으면 local 로 표시 — 빈 문자열을 그대로 흘리지 않는다")
    void fallsBackToLocal() {
        Map<String, String> info = call("", "");

        assertNotNull(info);
        assertEquals("local", info.get("commit"));
        assertEquals("local", info.get("branch"));
    }

    @Test
    @DisplayName("기동 시각이 항상 실려야 한다 — 커밋이 같아도 재기동 여부를 이 값으로 가른다")
    void alwaysReportsStartedAt() {
        String startedAt = call("abc", "master").get("startedAt");

        assertNotNull(startedAt);
        assertFalse(startedAt.isBlank());
    }

    @Test
    @DisplayName("8자 이하의 짧은 SHA 가 와도 잘리지 않는다")
    void keepsShortShaIntact() {
        assertEquals("abc123", call("abc123", "master").get("commit"));
    }
}
