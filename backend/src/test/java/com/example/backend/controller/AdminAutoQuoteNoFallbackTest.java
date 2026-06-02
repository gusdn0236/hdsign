package com.example.backend.controller;

import com.example.backend.security.JwtUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

import java.io.ByteArrayInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * slice-6 IRON LAW 회귀 잠금: <b>공개 공유 버킷 {@code r2.bucket}(hdsign-gallery)으로의 폴백은 절대 없다.</b>
 *
 * <p>이 테스트가 막는 결함(공개 갤러리 버킷이 코퍼스를 r2.dev 공개 URL 로 유출시킨 바로 그 사고):
 * 누군가 {@code AdminAutoQuoteController} 의 버킷 선택을
 * {@code bucket = autoquote.r2-bucket ?: r2.bucket} 처럼 "전용 버킷이 비면 공유 버킷으로 폴백"으로
 * 되돌리는 경우. 기존 테스트는 모두 이런 폴백을 통과시킨다(R2SourceTest 는 autoquote.r2-bucket 을
 * 설정해 폴백 분기에 들어가지 않고, UnavailableTest 는 {@code @MockBean S3Client} 가 없어
 * 재도입된 폴백이 실 S3 호출 → 에러 → graceful 503 으로 가려진다).
 *
 * <p>그 음성 분기를 차별적으로(discriminating) 검증하도록 구성한다:
 * <ul>
 *   <li>{@code autoquote.data-dir} → 존재하지 않는 디렉터리(파일시스템 소스 비활성)</li>
 *   <li>{@code autoquote.r2-bucket} → BLANK(전용 비공개 버킷 미설정)</li>
 *   <li>{@code r2.bucket} → {@code public-gallery-bucket} 으로 SET(공개 버킷이 구성된 운영 상황 시뮬레이션)</li>
 *   <li>{@code @MockBean S3Client} 는 <b>어떤 버킷이든</b> 유효한 corpus/priors 바이트를 돌려준다 —
 *       즉 공개 버킷을 읽으면 200 이 나올 환경이다.</li>
 * </ul>
 *
 * <p>올바른 구현(폴백 없음): 전용 버킷이 비었으니 R2 소스 자체가 비활성 → getObject 호출 없이 503.
 * 폴백이 (재)도입된 구현: {@code r2.bucket} 으로 getObject → 200 + 픽스처 코퍼스 → 이 테스트 FAIL.
 *
 * <p>실제 R2 네트워크는 호출하지 않는다(@MockBean).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AdminAutoQuoteNoFallbackTest {

    private static final String PUBLIC_BUCKET = "public-gallery-bucket";

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtUtil jwtUtil;

    @MockBean
    private S3Client s3Client;

    private final ObjectMapper json = new ObjectMapper();

    /**
     * 파일시스템 소스 OFF(부재 경로), 전용 비공개 버킷 OFF(blank), 공개 공유 버킷은 ON.
     * 폴백이 있으면 공개 버킷을 읽어 200 이 나오는 상황을 일부러 만든다.
     */
    @DynamicPropertySource
    static void noDedicatedBucketButPublicConfigured(DynamicPropertyRegistry registry) {
        registry.add("autoquote.data-dir", () -> "build/__autoquote_missing__/does-not-exist");
        // 전용 비공개 버킷 미설정 — 올바른 구현은 여기서 R2 소스를 끈다.
        registry.add("autoquote.r2-bucket", () -> "");
        registry.add("autoquote.r2-prefix", () -> "autoquote/");
        // 공개 공유 갤러리 버킷이 구성돼 있는 상황(폴백이 재도입되면 바로 이 버킷을 읽는다).
        registry.add("r2.bucket", () -> PUBLIC_BUCKET);
    }

    /**
     * getObject 가 <b>어떤 버킷이든</b> 유효한 corpus/priors 픽스처 바이트를 돌려주도록 스텁한다.
     * 즉 공개 버킷을 읽기만 하면 200 이 나오는 "성공할 환경" — 그럼에도 503 이어야 폴백이 없는 것.
     */
    @BeforeEach
    void stubAnyBucketServesCorpus() {
        when(s3Client.getObject(any(GetObjectRequest.class))).thenAnswer(inv -> {
            GetObjectRequest req = inv.getArgument(0);
            String key = req.key();
            String name = key.endsWith("priors.json") ? "priors.json" : "corpus.json";
            byte[] bytes = fixtureBytes(name);
            return new ResponseInputStream<>(
                    GetObjectResponse.builder().contentLength((long) bytes.length).build(),
                    AbortableInputStream.create(new ByteArrayInputStream(bytes)));
        });
    }

    private static byte[] fixtureBytes(String name) throws Exception {
        try (var in = AdminAutoQuoteNoFallbackTest.class.getResourceAsStream("/autoquote-fixtures/" + name)) {
            assertThat(in).as("fixture %s must exist", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private HttpEntity<Void> adminAuth() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(jwtUtil.generateAdminToken("test-admin"));
        return new HttpEntity<>(headers);
    }

    @Test
    void corpus_neverFallsBackToPublicBucket_returns503_noLeak() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);

        // 전용 버킷이 없으면 503 — 절대 200 이 아니다(폴백 재도입 시 200 이 되어 FAIL).
        assertThat(res.getStatusCode())
                .as("must be 503, never 200 — no fallback to the public gallery bucket")
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
        // 본문에 공개 버킷에서 받았을 픽스처 코퍼스 내용이 절대 새지 않아야 한다.
        assertThat(res.getBody())
                .doesNotContain("채널간판")
                .doesNotContain("unitPrice")
                .doesNotContain("test-fixture");
    }

    @Test
    void priors_neverFallsBackToPublicBucket_returns503_noLeak() throws Exception {
        ResponseEntity<String> res = rest.exchange(
                "/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        assertThat(res.getStatusCode())
                .as("must be 503, never 200 — no fallback to the public gallery bucket")
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);

        JsonNode body = json.readTree(res.getBody());
        assertThat(body.get("error").asText()).isEqualTo("autoquote_data_unavailable");
        // priors 픽스처 내용(sizeBuckets/synthDigest)이 본문에 새지 않아야 한다.
        assertThat(res.getBody())
                .doesNotContain("sizeBuckets")
                .doesNotContain("synthDigest");
    }

    /**
     * 핵심 차별 단언: 컨트롤러가 공개 공유 버킷({@code public-gallery-bucket})으로 getObject 를
     * <b>한 번도</b> 호출하지 않았다 — 사실 어떤 버킷으로도 호출하지 않았다(전용 버킷 미설정 → R2 소스 OFF).
     * 폴백이 재도입되면 이 버킷으로 호출이 발생해 FAIL 한다.
     */
    @Test
    void s3Client_isNeverInvokedForThePublicBucket() {
        rest.exchange("/api/admin/autoquote/corpus", HttpMethod.GET, adminAuth(), String.class);
        rest.exchange("/api/admin/autoquote/priors", HttpMethod.GET, adminAuth(), String.class);

        // 공개 버킷으로의 호출이 절대 없어야 한다(폴백 금지의 직접 증거).
        verify(s3Client, never()).getObject(
                argThat((GetObjectRequest r) -> r != null && PUBLIC_BUCKET.equals(r.bucket())));
        // 더 강하게: 전용 버킷이 없으니 어떤 getObject 호출도 일어나지 않아야 한다.
        verify(s3Client, never()).getObject(any(GetObjectRequest.class));
    }
}
