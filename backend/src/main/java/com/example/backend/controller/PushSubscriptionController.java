package com.example.backend.controller;

import com.example.backend.entity.PushSubscription;
import com.example.backend.repository.PushSubscriptionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.util.Map;

// 모바일 지시서 뷰어의 "알림 설정" — 전체 알림 받기 / 내 지시서만 알림받기 / 알림 끄기.
// 인증 없음(다른 /api/public/worksheets 엔드포인트와 동일한 보안 수준 — 현장 PWA 전용).
@Slf4j
@RestController
@RequestMapping("/api/public/push-subscriptions")
@RequiredArgsConstructor
public class PushSubscriptionController {

    private final PushSubscriptionRepository repository;

    // body: PushSubscription.toJSON() 결과({endpoint, keys:{p256dh, auth}}) + { mode: "ALL"|"MINE", worker }
    // 같은 endpoint 로 다시 오면 upsert(모드/직원 변경 반영).
    @PostMapping
    @SuppressWarnings("unchecked")
    public ResponseEntity<?> subscribe(@RequestBody Map<String, Object> body) {
        String endpoint = body.get("endpoint") instanceof String s ? s.trim() : null;
        if (endpoint == null || endpoint.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "endpoint 가 필요합니다."));
        }

        Map<String, Object> keys = body.get("keys") instanceof Map ? (Map<String, Object>) body.get("keys") : Map.of();
        String p256dh = keys.get("p256dh") instanceof String s ? s : null;
        String auth = keys.get("auth") instanceof String s ? s : null;
        if (p256dh == null || auth == null) {
            return ResponseEntity.badRequest().body(Map.of("message", "keys.p256dh / keys.auth 가 필요합니다."));
        }

        String modeRaw = body.get("mode") instanceof String s ? s.trim().toUpperCase() : "ALL";
        PushSubscription.Mode mode;
        try {
            mode = PushSubscription.Mode.valueOf(modeRaw);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", "mode 는 ALL 또는 MINE 이어야 합니다."));
        }

        String worker = body.get("worker") instanceof String s && !s.isBlank() ? s.trim() : null;
        if (mode == PushSubscription.Mode.MINE && worker == null) {
            return ResponseEntity.badRequest().body(Map.of("message", "mode=MINE 이면 worker 가 필요합니다."));
        }

        PushSubscription sub = repository.findByEndpoint(endpoint).orElseGet(() ->
                PushSubscription.builder().endpoint(endpoint).createdAt(LocalDateTime.now()).build());
        sub.setP256dh(p256dh);
        sub.setAuth(auth);
        sub.setMode(mode);
        sub.setWorker(worker);
        repository.save(sub);

        return ResponseEntity.ok(Map.of("mode", mode.name(), "worker", worker == null ? "" : worker));
    }

    // 알림 끄기 — 구독 row 자체를 삭제(= 이후 발송 대상에서 자동 제외).
    @DeleteMapping
    public ResponseEntity<?> unsubscribe(@RequestBody Map<String, Object> body) {
        String endpoint = body.get("endpoint") instanceof String s ? s.trim() : null;
        if (endpoint == null || endpoint.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "endpoint 가 필요합니다."));
        }
        repository.deleteByEndpoint(endpoint);
        return ResponseEntity.status(HttpStatus.NO_CONTENT).build();
    }
}
