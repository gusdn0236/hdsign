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

import java.net.URI;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

// 모바일 지시서 뷰어의 "알림 설정" — 전체 알림 받기 / 내 지시서만 알림받기 / 알림 끄기.
// 인증 없음(다른 /api/public/worksheets 엔드포인트와 동일한 보안 수준 — 현장 PWA 전용).
@Slf4j
@RestController
@RequestMapping("/api/public/push-subscriptions")
@RequiredArgsConstructor
public class PushSubscriptionController {

    private final PushSubscriptionRepository repository;

    // endpoint 컬럼 길이 상한. 넘으면 DB 가 예외를 던져 500 이 되므로 컨트롤러에서 400 으로 미리 막는다.
    private static final int MAX_ENDPOINT_LENGTH = 500;

    // 인증 없는 엔드포인트라 임의 문자열로 구독 row 를 무한히 만들 수 있다. 그렇게 들어간 가짜 구독은
    // 발송 시 DNS 오류(FAILED)라 GONE 이 아니고, 410 기반 자동 정리에도 안 걸려 영원히 남는다.
    // 그래서 실제 푸시 서비스 호스트만 화이트리스트로 통과시킨다.
    private static final List<String> ALLOWED_PUSH_HOSTS = List.of(
            "fcm.googleapis.com",                // Chrome / Edge / Android
            "web.push.apple.com",                // Safari / iOS PWA
            "updates.push.services.mozilla.com", // Firefox
            "notify.windows.com"                 // 구 Edge (WNS)
    );

    // body: PushSubscription.toJSON() 결과({endpoint, keys:{p256dh, auth}}) + { mode: "ALL"|"MINE", worker }
    // 같은 endpoint 로 다시 오면 upsert(모드/직원 변경 반영).
    @PostMapping
    @SuppressWarnings("unchecked")
    public ResponseEntity<?> subscribe(@RequestBody Map<String, Object> body) {
        String endpoint = body.get("endpoint") instanceof String s ? s.trim() : null;
        if (endpoint == null || endpoint.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "endpoint 가 필요합니다."));
        }
        if (endpoint.length() > MAX_ENDPOINT_LENGTH) {
            return ResponseEntity.badRequest().body(Map.of("message", "endpoint 가 너무 깁니다."));
        }
        if (!isAllowedEndpoint(endpoint)) {
            log.warn("허용되지 않은 푸시 endpoint 구독 시도: {}", endpoint);
            return ResponseEntity.badRequest().body(Map.of("message", "지원하지 않는 푸시 endpoint 입니다."));
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

    // https + 알려진 푸시 서비스 호스트인지. 호스트는 정확히 일치하거나 ".{호스트}" 로 끝나면 통과
    // (예: android.googleapis.com 이 아닌 sub.fcm.googleapis.com 형태의 리전 서브도메인 대응).
    private static boolean isAllowedEndpoint(String endpoint) {
        URI uri;
        try {
            uri = URI.create(endpoint);
        } catch (IllegalArgumentException e) {
            return false;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;

        String host = uri.getHost();
        if (host == null || host.isBlank()) return false;
        host = host.toLowerCase();

        for (String allowed : ALLOWED_PUSH_HOSTS) {
            if (host.equals(allowed) || host.endsWith("." + allowed)) return true;
        }
        return false;
    }
}
