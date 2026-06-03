package com.example.backend.autoquote.predict;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 자동견적 가격예측/근거 서빙이 회사 기밀 학습자산({@code priced_index.json}, 과거 명세서
 * {@code easyform_*_*.json}, 작업지시서 사진)을 런타임에 읽기 위한 공유 데이터 소스.
 *
 * <p>{@link com.example.backend.controller.AdminAutoQuoteController} 의 slice-6 레이어드 로딩
 * 패턴(파일시스템 우선 → 전용 비공개 R2 폴백)을 그대로 따른다. 같은 프로퍼티
 * ({@code autoquote.data-dir} / {@code autoquote.r2-bucket} / {@code autoquote.r2-prefix})를
 * 재사용하므로 운영에서는 {@code corpus.json}·{@code priors.json} 과 동일한 비공개 버킷 프리픽스
 * 아래에 {@code priced_index.json}·{@code easyform_*_*.json}·사진을 올려두면 된다.
 *
 * <p><b>Iron Law</b>: 이 자산들은 회사 기밀이라 공개 GitHub repo 에 절대 커밋하지 않으며
 * (런타임 로딩), 공개 갤러리 버킷({@code r2.bucket})으로의 폴백은 없다. 미프로비저닝 시
 * {@code null} 을 돌려 호출부가 graceful(503/404)하게 처리한다.
 */
@Component
public class AutoQuoteDataSource {

    /** 기밀 데이터 홈(파일시스템 소스). 설정·읽기 가능하면 R2 보다 우선. 미설정이면 R2 폴백. */
    @Value("${autoquote.data-dir:}")
    private String dataDir;

    /** 자동견적 전용 비공개 R2 버킷. data-dir 가 없을 때만 사용. 공개 갤러리 버킷 금지. */
    @Value("${autoquote.r2-bucket:}")
    private String bucket;

    /** R2 객체 키 프리픽스. {@code autoquote/} 아래에 자산을 둔다. */
    @Value("${autoquote.r2-prefix:autoquote/}")
    private String r2Prefix;

    private final S3Client s3Client;

    @Autowired
    public AutoQuoteDataSource(@Autowired(required = false) S3Client s3Client) {
        this.s3Client = s3Client;
    }

    /**
     * 이름으로 기밀 자산의 원본 바이트를 읽는다. 파일시스템(data-dir) → R2(bucket+prefix) 순서로
     * 시도하고, 어느 소스에서도 못 읽으면 {@code null}(예외 없음 — 호출부가 graceful 처리).
     *
     * @param name 자산 파일명(예: {@code priced_index.json}, {@code easyform_2022_corp.json}).
     *             경로 구분자가 포함되면 거부(디렉터리 탈출 방지)하고 {@code null} 반환.
     */
    public byte[] load(String name) {
        if (name == null || name.isBlank() || name.contains("/") || name.contains("\\")
                || name.contains("..")) {
            return null; // 경로 주입/탈출 방지: 단순 파일명만 허용.
        }
        byte[] fromFs = tryFilesystem(name);
        if (fromFs != null) {
            return fromFs;
        }
        return tryR2(name);
    }

    /** 파일시스템 소스. data-dir 미설정/부재이거나 파일이 없거나 IO 실패면 {@code null}. */
    private byte[] tryFilesystem(String name) {
        if (dataDir == null || dataDir.isBlank()) {
            return null;
        }
        Path p = Paths.get(dataDir, name).toAbsolutePath().normalize();
        if (!Files.isReadable(p) || Files.isDirectory(p)) {
            return null;
        }
        try {
            return Files.readAllBytes(p);
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * R2 소스. 버킷/클라이언트 없음·객체 없음(NoSuchKey)·자격증명 누락·IO 오류 모두 {@code null}.
     * R2 비밀/원본 예외는 로그/응답에 노출하지 않는다.
     */
    private byte[] tryR2(String name) {
        if (s3Client == null || bucket == null || bucket.isBlank()) {
            return null;
        }
        String prefix = (r2Prefix == null) ? "" : r2Prefix;
        String key = prefix + name;
        try (ResponseInputStream<GetObjectResponse> in = s3Client.getObject(
                GetObjectRequest.builder().bucket(bucket).key(key).build())) {
            return in.readAllBytes();
        } catch (SdkException | IOException e) {
            return null;
        }
    }
}
