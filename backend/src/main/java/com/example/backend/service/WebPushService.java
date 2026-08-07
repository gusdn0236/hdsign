package com.example.backend.service;

import com.example.backend.entity.PushSubscription;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import nl.martijndwars.webpush.Notification;
import nl.martijndwars.webpush.PushService;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.Security;

// 지시서 변경 웹푸시 실제 발송. VAPID 키는 최초 1회 `web-push generate-vapid-keys` (또는
// `npx web-push generate-vapid-keys`) 로 생성해 Railway 환경변수(VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY)로만 보관 — 코드/레포에 절대 커밋하지 않는다.
//
// 키가 비어있으면(로컬 개발 등) 조용히 비활성화 — 지시서 업로드 자체를 막지 않는다.
@Slf4j
@Service
public class WebPushService {

    @Value("${vapid.public-key:}")
    private String publicKey;

    @Value("${vapid.private-key:}")
    private String privateKey;

    @Value("${vapid.subject:mailto:admin@hdsigncraft.com}")
    private String subject;

    private PushService pushService;

    @PostConstruct
    public void init() {
        Security.addProvider(new BouncyCastleProvider());
        if (publicKey == null || publicKey.isBlank() || privateKey == null || privateKey.isBlank()) {
            log.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 가 설정되지 않아 웹푸시가 비활성화됩니다.");
            return;
        }
        try {
            pushService = new PushService(publicKey, privateKey, subject);
        } catch (Exception e) {
            log.error("웹푸시 PushService 초기화 실패: {}", e.getMessage());
        }
    }

    public boolean isEnabled() {
        return pushService != null;
    }

    // payloadJson 예: {"title":"지시서가 변경되었습니다","body":"...","url":"/m/worksheets/HD-1234","orderNumber":"HD-1234"}
    // best-effort — 만료/차단된 구독 하나의 발송 실패가 전체 업로드 흐름을 막으면 안 되므로
    // 여기서 예외를 삼킨다. 410/404 응답(구독 만료)이 반복되는 endpoint 는 추후 정리 배치로 청소 가능.
    public void send(PushSubscription sub, String payloadJson) {
        if (!isEnabled()) return;
        try {
            nl.martijndwars.webpush.Subscription subscription = new nl.martijndwars.webpush.Subscription(
                    sub.getEndpoint(),
                    new nl.martijndwars.webpush.Subscription.Keys(sub.getP256dh(), sub.getAuth())
            );
            pushService.send(new Notification(subscription, payloadJson));
        } catch (Exception e) {
            log.warn("푸시 발송 실패 [id={}]: {}", sub.getId(), e.getMessage());
        }
    }
}
