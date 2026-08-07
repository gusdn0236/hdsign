package com.example.backend.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

// 배포 확인용 — "지금 프로덕션에 어떤 커밋이 떠 있나" 를 밖에서 알 수 있게 한다.
//
// 이게 없어서 2026-08 에 웹푸시 인코딩 전환 배포가 반영됐는지를 30분 넘게 확인하지
// 못했다. Railway 는 응답 헤더에 버전 정보를 넣지 않아서, 배포 여부를 재기동 순간의
// 짧은 502 를 잡아내는 걸로만 추정해야 했고 그건 놓치면 그만이다.
//
// 커밋 해시와 기동 시각만 준다. 커밋 메시지·작성자·레포명도 Railway 가 넣어주지만
// 인증 없는 엔드포인트에 굳이 노출할 이유가 없다.
@RestController
@RequestMapping("/api/public/build-info")
public class BuildInfoController {

    // Railway 가 GitHub 트리거 배포에 자동 주입하는 값. 로컬 실행 시엔 비어 있다.
    @Value("${RAILWAY_GIT_COMMIT_SHA:}")
    private String commitSha;

    @Value("${RAILWAY_GIT_BRANCH:}")
    private String branch;

    // 이 인스턴스가 뜬 시각 — 재기동이 실제로 일어났는지 판단하는 근거가 된다.
    // (커밋이 같아도 이 값이 바뀌면 재배포·재시작이 있었다는 뜻)
    private final LocalDateTime startedAt = LocalDateTime.now();

    @GetMapping
    public ResponseEntity<Map<String, String>> buildInfo() {
        Map<String, String> info = new LinkedHashMap<>();
        info.put("commit", shortSha());
        info.put("branch", isBlank(branch) ? "local" : branch);
        info.put("startedAt", startedAt.toString());
        return ResponseEntity.ok(info);
    }

    // 앞 8자리면 커밋을 특정하기 충분하다(git log --oneline 과 같은 길이).
    private String shortSha() {
        if (isBlank(commitSha)) return "local";
        return commitSha.length() <= 8 ? commitSha : commitSha.substring(0, 8);
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
