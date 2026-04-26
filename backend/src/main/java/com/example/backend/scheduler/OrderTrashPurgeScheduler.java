package com.example.backend.scheduler;

import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Slf4j
@Component
@RequiredArgsConstructor
public class OrderTrashPurgeScheduler {

    private static final int RETENTION_DAYS = 30;

    private final OrderRepository orderRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    // 매일 새벽 3시: 휴지통에서 30일 이상 경과한 작업을 영구 삭제
    @Scheduled(cron = "0 0 3 * * *")
    @Transactional
    public void purgeExpiredTrash() {
        LocalDateTime cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS);
        List<Order> expired = orderRepository.findByDeletedAtBefore(cutoff);
        if (expired.isEmpty()) return;

        log.info("[TrashPurge] purging {} order(s) deleted before {}", expired.size(), cutoff);
        for (Order order : expired) {
            try {
                purgeR2Files(order);
                orderRepository.delete(order);
            } catch (Exception e) {
                log.warn("[TrashPurge] failed to purge order {}: {}", order.getId(), e.getMessage());
            }
        }
    }

    private void purgeR2Files(Order order) {
        List<String> keys = new ArrayList<>();
        for (OrderFile file : order.getFiles()) {
            if (file.getStoredName() != null && !file.getStoredName().isBlank()) {
                keys.add(file.getStoredName());
            }
            String previewKey = extractKeyFromPublicUrl(file.getPreviewUrl());
            if (previewKey != null) keys.add(previewKey);
        }
        // 지시서 PDF 도 함께 정리 — Order 컬럼이라 위 file 루프에 안 들어와 누수되던 지점.
        String worksheetKey = extractKeyFromPublicUrl(order.getWorksheetPdfUrl());
        if (worksheetKey != null) keys.add(worksheetKey);

        for (String key : keys) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket).key(key).build());
            } catch (Exception ignored) {
                // best-effort
            }
        }
    }

    private String extractKeyFromPublicUrl(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;
        String base = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(base)) return null;
        return url.substring(base.length());
    }
}
