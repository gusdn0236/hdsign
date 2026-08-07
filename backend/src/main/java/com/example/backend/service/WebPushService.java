package com.example.backend.service;

import com.example.backend.entity.PushSubscription;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import nl.martijndwars.webpush.Notification;
import nl.martijndwars.webpush.PushService;
import org.apache.http.HttpResponse;
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

    // 발송 결과. GONE 은 "이 구독은 영구히 죽었다" 는 뜻으로, 호출부가 DB 에서 지워야 한다.
    // FAILED 는 일시적 실패(네트워크/5xx)일 수 있으므로 지우지 않고 다음 기회를 노린다.
    public enum SendResult {
        OK,        // 2xx — 정상 전달
        GONE,      // 404/410 — 구독 만료·해지. 되살아나지 않으므로 삭제 대상
        FAILED,    // 그 외 오류 — 일시적일 수 있어 보존
        DISABLED   // VAPID 키 미설정으로 푸시 자체가 꺼짐
    }

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
    // best-effort — 구독 하나의 발송 실패가 전체 업로드 흐름을 막으면 안 되므로 여기서 예외를 삼킨다.
    // 대신 결과를 돌려줘서 호출부가 죽은 구독을 정리할 수 있게 한다.
    public SendResult send(PushSubscription sub, String payloadJson) {
        if (!isEnabled()) return SendResult.DISABLED;
        try {
            nl.martijndwars.webpush.Subscription subscription = new nl.martijndwars.webpush.Subscription(
                    sub.getEndpoint(),
                    new nl.martijndwars.webpush.Subscription.Keys(sub.getP256dh(), sub.getAuth())
            );
            HttpResponse res = pushService.send(new Notification(subscription, payloadJson));
            int status = res.getStatusLine().getStatusCode();

            // 404 Not Found / 410 Gone = 브라우저가 구독을 폐기함(앱 삭제, 데이터 초기화, 알림 차단 등).
            // RFC 8030 상 이 endpoint 는 다시 살아나지 않으므로 DB 에서 지운다.
            if (status == 404 || status == 410) {
                log.info("푸시 구독 만료 [id={}, status={}] — 정리 대상", sub.getId(), status);
                return SendResult.GONE;
            }
            if (status >= 200 && status < 300) {
                return SendResult.OK;
            }
            log.warn("푸시 발송 실패 [id={}, status={}]", sub.getId(), status);
            return SendResult.FAILED;
        } catch (Exception e) {
            log.warn("푸시 발송 예외 [id={}]: {}", sub.getId(), e.getMessage());
            return SendResult.FAILED;
        }
    }
}
