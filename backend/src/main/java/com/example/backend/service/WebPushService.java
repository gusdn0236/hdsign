package com.example.backend.service;

import com.example.backend.entity.PushSubscription;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import nl.martijndwars.webpush.AbstractPushService;
import nl.martijndwars.webpush.Encoding;
import nl.martijndwars.webpush.Notification;
import nl.martijndwars.webpush.Subscription;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.security.Security;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// 지시서 변경 웹푸시 실제 발송. VAPID 키는 최초 1회 `web-push generate-vapid-keys` (또는
// `npx web-push generate-vapid-keys`) 로 생성해 Railway 환경변수(VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY)로만 보관 — 코드/레포에 절대 커밋하지 않는다.
//
// 키가 비어있으면(로컬 개발 등) 조용히 비활성화 — 지시서 업로드 자체를 막지 않는다.
//
// ⚠️ 왜 라이브러리의 PushService 를 안 쓰는가 (2026-08 결정):
// nl.martijndwars web-push 5.1.2 의 PushService.send() 는 내부적으로 sendAsync() 를 부르는데,
// 그게 알림 1건마다 HttpAsyncClients.createSystem() 으로 HTTP 클라이언트를 통째로 새로 만들고
// start() 한 뒤 콜백에서 닫는다. 기기 20대면 IO 리액터 스레드풀 20개 생성/종료 + TLS 핸드셰이크
// 20번이다. 게다가 소켓 타임아웃이 사실상 무제한이라, 응답을 안 주는 푸시 엔드포인트 하나가
// 호출 스레드를 무한정 물 수 있다(그 스레드는 사진 백업/메일과 공유하는 풀이다).
// PushAsyncService 는 클라이언트를 재사용하지만 private final 로 박아둬서 타임아웃을 못 건다.
//
// 그래서 암호화·VAPID JWT 서명 같은 까다로운 부분만 라이브러리(prepareRequest)에 맡기고,
// 전송은 JDK 내장 HttpClient 하나를 재사용한다. 커넥션 풀 + HTTP/2 멀티플렉싱이 붙고
// (FCM 처럼 대부분의 구독이 같은 호스트라 효과가 크다) 타임아웃도 명시할 수 있다.
// 새 의존성은 추가되지 않는다.
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

    // 페이로드 암호화 방식 (2026-08 결정).
    //
    // 표준(RFC 8291)이 요구하는 건 aes128gcm 하나뿐이고, 구 draft-04 방식인 aesgcm 은
    // 브라우저가 지원해도 되고 안 해도 되는 선택 사항이다. Chrome/Firefox 는 표준 확정 전부터
    // 웹푸시가 있었어서 둘 다 받지만, Safari/iOS 는 2023년(iOS 16.4)에 웹푸시를 넣었기 때문에
    // 구 방식을 지원할 이유가 없다 — 아이폰에만 알림이 안 가는 원인이 될 수 있다.
    //
    // 라이브러리 PushService.send() 의 기본값이 AESGCM 이라 여태 그걸 쓰고 있었을 뿐,
    // 의도한 선택이 아니었다. 표준으로 맞춘다.
    //
    // ⚠️ 이 값을 바꾸면 요청 형태가 통째로 달라진다(prepareRequest 참고):
    //   - Content-Encoding: aesgcm → aes128gcm
    //   - salt/dh 가 Encryption·Crypto-Key 헤더에서 빠지고 본문 안으로 들어간다
    //   - Authorization: "WebPush {jwt}" → "vapid t={jwt}, k={공개키}"
    //   - FCM 주소의 fcm/send 가 wp 로 재작성된다
    // 즉 안드로이드 요청까지 전부 형태가 바뀐다. 되돌릴 때는 이 상수만 AESGCM 으로.
    private static final Encoding ENCODING = Encoding.AES128GCM;

    // 커넥션 수립 5초, 요청 전체 10초. 옛 구현의 "무한정 대기" 를 없애는 게 이 상수의 목적이다.
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);

    // 응답 본문은 실패 진단용으로만 쓰므로 앞부분만 남긴다.
    private static final int ERROR_BODY_LOG_LIMIT = 200;

    @Value("${vapid.public-key:}")
    private String publicKey;

    @Value("${vapid.private-key:}")
    private String privateKey;

    @Value("${vapid.subject:mailto:admin@hdsigncraft.com}")
    private String subject;

    private VapidRequestFactory requestFactory;
    private HttpClient httpClient;
    private ExecutorService httpExecutor;

    @PostConstruct
    public void init() {
        Security.addProvider(new BouncyCastleProvider());
        if (publicKey == null || publicKey.isBlank() || privateKey == null || privateKey.isBlank()) {
            log.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 가 설정되지 않아 웹푸시가 비활성화됩니다.");
            return;
        }
        try {
            requestFactory = new VapidRequestFactory(publicKey, privateKey, subject);
            // 응답 콜백 처리용 소형 풀. 실제 IO 는 HttpClient 의 selector 가 돌리므로 크게 잡을 필요가 없다.
            httpExecutor = Executors.newFixedThreadPool(4, r -> {
                Thread t = new Thread(r, "webpush-http");
                t.setDaemon(true);
                return t;
            });
            httpClient = HttpClient.newBuilder()
                    .connectTimeout(CONNECT_TIMEOUT)
                    .executor(httpExecutor)
                    .build();
        } catch (Exception e) {
            log.error("웹푸시 초기화 실패: {}", e.getMessage());
            requestFactory = null;
            shutdownExecutor();
        }
    }

    @PreDestroy
    public void shutdown() {
        shutdownExecutor();
    }

    public boolean isEnabled() {
        return requestFactory != null && httpClient != null;
    }

    // payloadJson 예: {"title":"○○기획 지시서 내용이 변경되었습니다","body":"간판 규격 3000x600 으로 수정",
    //                  "url":"/m/worksheets/HD-1234","orderNumber":"HD-1234"}
    // best-effort — 구독 하나의 발송 실패가 전체 업로드 흐름을 막으면 안 되므로 여기서 예외를 삼킨다.
    // 대신 결과를 돌려줘서 호출부가 죽은 구독을 정리할 수 있게 한다.
    //
    // 반환 future 는 절대 예외로 완료되지 않는다(모든 실패를 FAILED 로 접는다) — 호출부가
    // join() 을 마음 놓고 쓸 수 있게 하기 위한 계약이다. 요청 타임아웃이 걸려 있으므로
    // join() 이 REQUEST_TIMEOUT 보다 오래 매달리는 일도 없다.
    public CompletableFuture<SendResult> sendAsync(PushSubscription sub, String payloadJson) {
        // 지역 변수로 한 번만 읽는다 — 종료 중에 shutdown() 이 필드를 비우면 검사와 사용 사이에서
        // NPE 가 나고, 그건 future 가 아니라 이 메서드 밖으로 튀어 호출부의 정리 로직을 통째로 날린다.
        HttpClient client = this.httpClient;
        if (requestFactory == null || client == null) {
            return CompletableFuture.completedFuture(SendResult.DISABLED);
        }

        Long id = sub.getId();
        HttpRequest request;
        try {
            request = toHttpRequest(sub, payloadJson);
        } catch (Exception e) {
            // 키 파싱/암호화 실패 — 이 구독의 p256dh·auth 가 깨진 경우다. 재시도해도 같으니 남기기만 한다.
            log.warn("푸시 요청 생성 실패 [id={}]: {}", id, e.getMessage());
            return CompletableFuture.completedFuture(SendResult.FAILED);
        }

        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .handle((res, err) -> {
                    if (err != null) {
                        log.warn("푸시 발송 예외 [id={}]: {}", id, rootMessage(err));
                        return SendResult.FAILED;
                    }
                    int status = res.statusCode();

                    // 404 Not Found / 410 Gone = 브라우저가 구독을 폐기함(앱 삭제, 데이터 초기화, 알림 차단 등).
                    // RFC 8030 상 이 endpoint 는 다시 살아나지 않으므로 DB 에서 지운다.
                    if (status == 404 || status == 410) {
                        log.info("푸시 구독 만료 [id={}, status={}] — 정리 대상", id, status);
                        return SendResult.GONE;
                    }
                    if (status >= 200 && status < 300) {
                        return SendResult.OK;
                    }
                    // 푸시 서버가 준 본문을 같이 남긴다 — 인코딩/헤더 문제는 여기에만 드러난다.
                    log.warn("푸시 발송 실패 [id={}, status={}]: {}", id, status, truncate(res.body()));
                    return SendResult.FAILED;
                });
    }

    // 라이브러리로 암호화·VAPID 서명까지 끝낸 요청을 JDK HttpRequest 로 옮겨 담는다.
    // prepareRequest 가 만드는 헤더(TTL/Content-Type/Content-Encoding/Encryption/Crypto-Key/
    // Authorization)는 전부 JDK HttpClient 가 막는 제한 헤더(Host, Content-Length 등)가 아니다.
    private HttpRequest toHttpRequest(PushSubscription sub, String payloadJson) throws Exception {
        Notification notification = new Notification(
                new Subscription(sub.getEndpoint(), new Subscription.Keys(sub.getP256dh(), sub.getAuth())),
                payloadJson
        );
        nl.martijndwars.webpush.HttpRequest prepared = requestFactory.build(notification, ENCODING);

        byte[] body = prepared.getBody();
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(prepared.getUrl()))
                .timeout(REQUEST_TIMEOUT)
                .POST(body == null ? HttpRequest.BodyPublishers.noBody()
                                   : HttpRequest.BodyPublishers.ofByteArray(body));
        for (Map.Entry<String, String> header : prepared.getHeaders().entrySet()) {
            builder.header(header.getKey(), header.getValue());
        }
        return builder.build();
    }

    private void shutdownExecutor() {
        if (httpExecutor != null) {
            httpExecutor.shutdown();
            httpExecutor = null;
        }
        httpClient = null;
    }

    private static String rootMessage(Throwable t) {
        Throwable cause = t instanceof CompletionException && t.getCause() != null ? t.getCause() : t;
        String message = cause.getMessage();
        return message == null || message.isBlank() ? cause.getClass().getSimpleName() : message;
    }

    private static String truncate(String body) {
        if (body == null || body.isBlank()) return "(본문 없음)";
        String flat = body.strip().replaceAll("\\s+", " ");
        return flat.length() <= ERROR_BODY_LOG_LIMIT ? flat : flat.substring(0, ERROR_BODY_LOG_LIMIT) + "…";
    }

    // prepareRequest 는 protected 라 외부에서 못 부른다. 상속으로만 열어 쓰는 얇은 어댑터 —
    // 라이브러리의 발송 구현(PushService/PushAsyncService)은 일부러 쓰지 않는다.
    private static final class VapidRequestFactory extends AbstractPushService<VapidRequestFactory> {
        VapidRequestFactory(String publicKey, String privateKey, String subject) throws GeneralSecurityException {
            super(publicKey, privateKey, subject);
        }

        nl.martijndwars.webpush.HttpRequest build(Notification notification, Encoding encoding) throws Exception {
            return prepareRequest(notification, encoding);
        }
    }
}
