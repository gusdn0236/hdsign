package com.example.backend.service;

import com.example.backend.entity.PushSubscription;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import nl.martijndwars.webpush.Utils;
import org.bouncycastle.jce.ECNamedCurveTable;
import org.bouncycastle.jce.interfaces.ECPrivateKey;
import org.bouncycastle.jce.interfaces.ECPublicKey;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.jce.spec.ECNamedCurveParameterSpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Security;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * WebPushService 는 라이브러리의 PushService 를 쓰지 않고 암호화·VAPID 서명 결과를 JDK HttpClient
 * 요청으로 직접 옮겨 담는다. 그 "옮겨 담기" 가 조용히 틀어지면 알림이 그냥 안 가고 아무도 모르므로,
 * 실제 로컬 HTTP 서버를 띄워 발송 경로를 통째로 태워 본다.
 */
class WebPushServiceTest {

    private static String vapidPublicKey;
    private static String vapidPrivateKey;
    private static String subscriberP256dh;
    private static String subscriberAuth;

    private HttpServer server;
    private WebPushService service;
    private final AtomicReference<CapturedRequest> captured = new AtomicReference<>();
    private volatile int responseStatus = 201;

    private record CapturedRequest(String method, String path, Map<String, String> headers, int bodyLength) {
    }

    @BeforeAll
    static void generateKeys() throws Exception {
        Security.addProvider(new BouncyCastleProvider());

        KeyPair vapid = generateP256KeyPair();
        vapidPublicKey = urlBase64(Utils.encode((ECPublicKey) vapid.getPublic()));
        vapidPrivateKey = urlBase64(Utils.encode((ECPrivateKey) vapid.getPrivate()));

        KeyPair subscriber = generateP256KeyPair();
        subscriberP256dh = urlBase64(Utils.encode((ECPublicKey) subscriber.getPublic()));

        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        subscriberAuth = urlBase64(auth);
    }

    @BeforeEach
    void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/push", this::handle);
        server.start();

        service = new WebPushService();
        ReflectionTestUtils.setField(service, "publicKey", vapidPublicKey);
        ReflectionTestUtils.setField(service, "privateKey", vapidPrivateKey);
        ReflectionTestUtils.setField(service, "subject", "mailto:test@example.com");
        service.init();
    }

    @AfterEach
    void stopServer() {
        if (service != null) service.shutdown();
        if (server != null) server.stop(0);
    }

    private void handle(HttpExchange exchange) throws java.io.IOException {
        byte[] body = exchange.getRequestBody().readAllBytes();
        Map<String, String> headers = new java.util.HashMap<>();
        exchange.getRequestHeaders().forEach((k, v) -> headers.put(k.toLowerCase(), String.join(",", v)));
        captured.set(new CapturedRequest(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
                headers, body.length));

        exchange.sendResponseHeaders(responseStatus, -1);
        exchange.close();
    }

    @Test
    @DisplayName("2xx 응답이면 OK 를 돌려주고, 푸시 서버가 받은 요청이 웹푸시 규격을 갖춘다")
    void sendsWellFormedRequest() {
        responseStatus = 201;

        WebPushService.SendResult result = service.sendAsync(subscription(), "{\"title\":\"안녕\"}").join();

        assertEquals(WebPushService.SendResult.OK, result);

        CapturedRequest request = captured.get();
        assertNotNull(request, "푸시 서버가 요청을 아예 못 받았다");
        assertEquals("POST", request.method());
        assertEquals("/push/device-1", request.path());

        // 라이브러리가 만든 헤더가 JDK HttpClient 요청으로 온전히 옮겨졌는지 — 이 이관이 이 클래스의 핵심.
        assertEquals("aesgcm", request.headers().get("content-encoding"));
        assertEquals("application/octet-stream", request.headers().get("content-type"));
        assertNotNull(request.headers().get("ttl"), "TTL 헤더 누락");

        String authorization = request.headers().get("authorization");
        assertNotNull(authorization, "Authorization(VAPID JWT) 헤더 누락");
        assertTrue(authorization.startsWith("WebPush "), "AESGCM 인코딩의 VAPID 형식이 아님: " + authorization);

        String cryptoKey = request.headers().get("crypto-key");
        assertNotNull(cryptoKey, "Crypto-Key 헤더 누락");
        assertTrue(cryptoKey.contains("dh="), "Crypto-Key 에 dh= 없음: " + cryptoKey);
        assertTrue(cryptoKey.contains("p256ecdsa="), "Crypto-Key 에 p256ecdsa= 없음: " + cryptoKey);

        assertNotNull(request.headers().get("encryption"), "Encryption(salt) 헤더 누락");
        assertTrue(request.bodyLength() > 0, "암호화된 페이로드가 비어 있음");
    }

    @Test
    @DisplayName("410 Gone 이면 GONE — 호출부가 구독을 삭제할 수 있어야 한다")
    void mapsGoneStatus() {
        responseStatus = 410;
        assertEquals(WebPushService.SendResult.GONE, service.sendAsync(subscription(), "{}").join());
    }

    @Test
    @DisplayName("404 도 GONE 으로 본다")
    void mapsNotFoundStatus() {
        responseStatus = 404;
        assertEquals(WebPushService.SendResult.GONE, service.sendAsync(subscription(), "{}").join());
    }

    @Test
    @DisplayName("4xx/5xx 는 FAILED — 일시적일 수 있으니 구독을 지우면 안 된다")
    void mapsFailureStatus() {
        responseStatus = 400;
        assertEquals(WebPushService.SendResult.FAILED, service.sendAsync(subscription(), "{}").join());
    }

    @Test
    @DisplayName("접속 자체가 안 되면 예외가 아니라 FAILED 로 접힌다")
    void networkErrorBecomesFailed() {
        PushSubscription dead = subscription();
        // 서버를 내려서 커넥션 거부를 만든다 — future 가 예외로 완료되면 호출부의 join() 이 터진다.
        server.stop(0);

        assertEquals(WebPushService.SendResult.FAILED, service.sendAsync(dead, "{}").join());
    }

    @Test
    @DisplayName("VAPID 키가 없으면 DISABLED — 발송 시도 자체를 하지 않는다")
    void disabledWithoutKeys() {
        WebPushService disabled = new WebPushService();
        ReflectionTestUtils.setField(disabled, "publicKey", "");
        ReflectionTestUtils.setField(disabled, "privateKey", "");
        disabled.init();

        assertEquals(WebPushService.SendResult.DISABLED, disabled.sendAsync(subscription(), "{}").join());
    }

    private PushSubscription subscription() {
        return PushSubscription.builder()
                .id(1L)
                .endpoint("http://" + server.getAddress().getHostString() + ":" + server.getAddress().getPort()
                        + "/push/device-1")
                .p256dh(subscriberP256dh)
                .auth(subscriberAuth)
                .mode(PushSubscription.Mode.ALL)
                .build();
    }

    private static KeyPair generateP256KeyPair() throws Exception {
        ECNamedCurveParameterSpec spec = ECNamedCurveTable.getParameterSpec("prime256v1");
        KeyPairGenerator generator = KeyPairGenerator.getInstance("ECDH", "BC");
        generator.initialize(spec);
        return generator.generateKeyPair();
    }

    private static String urlBase64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
