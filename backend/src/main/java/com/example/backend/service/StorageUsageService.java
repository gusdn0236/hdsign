package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Response;
import software.amazon.awssdk.services.s3.model.S3Object;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * R2 버킷 사용량 집계 — 작업완료 탭의 프로그레스 바와 [지금 정리] 판단에 사용.
 *
 * <p>R2 는 사용한 만큼 과금되는 모델이라 "남은 용량" 개념이 본질적으로 없다. 그래서
 * 한도는 {@code storage.quota-gb}({@code STORAGE_QUOTA_GB} 환경변수, 기본 10GB) 로 두고,
 * 관리자가 "이만큼 차면 정리해야지" 하는 자체 임계치로 사용한다. 10GB 는 Cloudflare R2
 * Standard 의 무료 분량과 정확히 일치 — 이 값을 넘기 시작하면 GB 당 $0.015/월 과금.
 *
 * <p>전체 버킷을 ListObjectsV2 로 페이지네이션 — 객체 합이 백만 단위로 커지면 비용이
 * 늘지만, 결과를 60초 캐시해 한 분 안에 N 명이 탭을 열어도 R2 호출은 한 번. 결과 신선도
 * 60초면 사용자 입장에선 "방금 삭제했더니 줄었네" 가 곧바로 보이고, 비용 면에선 list 호출
 * 비용($0.36/100만 클래스B request) 이 사실상 무시할 수 있는 수준이 된다.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StorageUsageService {

    private static final Duration CACHE_TTL = Duration.ofSeconds(60);
    private static final long BYTES_PER_GB = 1024L * 1024L * 1024L;

    private final S3Client s3Client;
    private final OrderRepository orderRepository;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${storage.quota-gb:10}")
    private double quotaGb;

    // (timestamp, snapshot) — null 이면 캐시 미스. ConcurrentHashMap 등은 과한 수준의 동시성 없음.
    private volatile Instant cachedAt;
    private volatile Map<String, Long> cachedByOrderNumber;
    private volatile long cachedGalleryBytes;
    private volatile long cachedTotalBytes;

    /**
     * 작업완료 탭 상단 프로그레스 바 데이터.
     * <ul>
     *   <li>totalBytes: 버킷 전체 합산(발주+갤러리)</li>
     *   <li>quotaBytes: STORAGE_QUOTA_GB 의 바이트 환산</li>
     *   <li>trashBytes: deletedAt 이 있는 주문들의 R2 합</li>
     *   <li>activeOrderBytes: deletedAt 이 없는 주문들의 R2 합</li>
     *   <li>galleryBytes: orders/ prefix 외(갤러리 카테고리 폴더들)</li>
     * </ul>
     */
    public Map<String, Object> getUsage() {
        ensureFreshSnapshot();

        Set<String> trashOrderNumbers = new HashSet<>();
        Set<String> activeOrderNumbers = new HashSet<>();
        // findAll 한 번이면 충분 — 발주가 수만 건 단위로 커지기 전엔 메모리 부담 없음.
        // 커지면 별도 SELECT order_number, deleted_at 으로 가볍게 바꾸면 됨.
        for (Order order : orderRepository.findAll()) {
            if (order.getOrderNumber() == null) continue;
            if (order.getDeletedAt() != null) trashOrderNumbers.add(order.getOrderNumber());
            else activeOrderNumbers.add(order.getOrderNumber());
        }

        long trashBytes = 0L;
        long activeBytes = 0L;
        long orphanOrderBytes = 0L; // R2 엔 있는데 DB 에 매칭되는 주문이 없는 경우 — 누수 감지용
        for (Map.Entry<String, Long> entry : cachedByOrderNumber.entrySet()) {
            String orderNumber = entry.getKey();
            long bytes = entry.getValue();
            if (trashOrderNumbers.contains(orderNumber)) trashBytes += bytes;
            else if (activeOrderNumbers.contains(orderNumber)) activeBytes += bytes;
            else orphanOrderBytes += bytes;
        }

        long quotaBytes = Math.max(1L, (long) (quotaGb * BYTES_PER_GB));
        double percent = Math.min(100.0, 100.0 * cachedTotalBytes / quotaBytes);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("totalBytes", cachedTotalBytes);
        body.put("quotaBytes", quotaBytes);
        body.put("quotaGb", quotaGb);
        body.put("percent", Math.round(percent * 10.0) / 10.0);
        body.put("trashBytes", trashBytes);
        body.put("activeOrderBytes", activeBytes);
        body.put("galleryBytes", cachedGalleryBytes);
        body.put("orphanOrderBytes", orphanOrderBytes);
        body.put("trashOrderCount", trashOrderNumbers.size());
        body.put("snapshotAt", cachedAt.toString());
        body.put("cacheTtlSeconds", CACHE_TTL.getSeconds());
        return body;
    }

    /** 캐시 즉시 무효화 — 영구 삭제 직후 다음 호출에서 새 수치를 받게 한다. */
    public void invalidateCache() {
        cachedAt = null;
    }

    private synchronized void ensureFreshSnapshot() {
        if (cachedAt != null && Duration.between(cachedAt, Instant.now()).compareTo(CACHE_TTL) < 0) {
            return;
        }

        Map<String, Long> byOrder = new HashMap<>();
        long galleryBytes = 0L;
        long total = 0L;

        String continuation = null;
        // 1000 객체씩 페이지네이션 — 버킷 크기가 커도 메모리는 합산 카운터만 점유.
        do {
            ListObjectsV2Request.Builder req = ListObjectsV2Request.builder().bucket(bucket).maxKeys(1000);
            if (continuation != null) req.continuationToken(continuation);
            ListObjectsV2Response resp;
            try {
                resp = s3Client.listObjectsV2(req.build());
            } catch (Exception e) {
                log.warn("R2 ListObjectsV2 실패 — bucket={}: {}", bucket, e.getMessage());
                break;
            }
            List<S3Object> contents = resp.contents();
            for (S3Object obj : contents) {
                String key = obj.key();
                long size = obj.size() == null ? 0L : obj.size();
                total += size;
                String orderNumber = extractOrderNumber(key);
                if (orderNumber != null) byOrder.merge(orderNumber, size, Long::sum);
                else galleryBytes += size;
            }
            continuation = Boolean.TRUE.equals(resp.isTruncated()) ? resp.nextContinuationToken() : null;
        } while (continuation != null);

        cachedByOrderNumber = byOrder;
        cachedGalleryBytes = galleryBytes;
        cachedTotalBytes = total;
        cachedAt = Instant.now();
        log.info("[StorageUsage] 갱신 — totalBytes={}, galleryBytes={}, orderCount={}",
                total, galleryBytes, byOrder.size());
    }

    /** {@code "orders/2026-05-100/...."} → {@code "2026-05-100"}. orders 외 prefix 는 null. */
    private static String extractOrderNumber(String key) {
        if (key == null || !key.startsWith("orders/")) return null;
        int next = key.indexOf('/', "orders/".length());
        if (next < 0) return null;
        String orderNumber = key.substring("orders/".length(), next);
        return orderNumber.isBlank() ? null : orderNumber;
    }
}
