package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.util.ArrayList;
import java.util.List;

/**
 * 작업완료 항목의 완전삭제 — 관리자가 작업완료 탭에서 [영구삭제] 를 누르거나, 30일 경과 후
 * 스케줄러가 자동으로 호출. R2 의 도안 원본·미리보기·지시서 PDF·썸네일·order_files 행을
 * 모두 지우고 Order 행까지 같이 하드 삭제한다. 아카이브(최소 레코드 보존) 흐름은 폐기됨.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderArchiveService {

    private final OrderRepository orderRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    /**
     * R2 파일 + Order 행을 같이 하드 삭제.
     */
    @Transactional
    public void hardDeleteOrder(Order order) {
        purgeR2Files(order);                        // 반드시 행 삭제 전에 — 키 추출이 order/files 에서 됨
        orderRepository.delete(order);
        log.info("[Purge] order {} hard-deleted — R2 files removed, row removed", order.getOrderNumber());
    }

    private void purgeR2Files(Order order) {
        List<String> keys = new ArrayList<>();
        for (OrderFile file : order.getFiles()) {
            if (file.getStoredName() != null && !file.getStoredName().isBlank()) keys.add(file.getStoredName());
            addKey(keys, file.getPreviewUrl());
        }
        addKey(keys, order.getWorksheetPdfUrl());
        addKey(keys, order.getWorksheetOriginalPdfUrl());
        addKey(keys, order.getWorksheetThumbnailUrl());
        for (String key : keys) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
            } catch (Exception ignored) {
                // best-effort — 키가 이미 없거나 일시 오류여도 레코드 정리는 진행
            }
        }
    }

    private void addKey(List<String> keys, String url) {
        String k = extractKey(url);
        if (k != null && !keys.contains(k)) keys.add(k);
    }

    private String extractKey(String url) {
        if (url == null || url.isBlank() || publicUrl == null || publicUrl.isBlank()) return null;
        String base = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(base)) return null;
        return url.substring(base.length());
    }
}
