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
 * "영구삭제" 의 실제 동작 — 휴지통에서 관리자가 [영구삭제] 를 누르거나 휴지통에 들어간 지
 * 30일이 지나 자동으로 정리될 때 호출. R2 의 도안 원본·미리보기·지시서 PDF(평탄화/원본)·
 * 썸네일을 전부 지우고 Order 행도 같이 삭제한다.
 *
 * NOTE(2026-05-13): 한때 "현장 옛 지시서 찾기" 용으로 최소 레코드를 남기고 purgedAt 을 찍는
 * 아카이브 흐름이 있었으나 운영상 안 쓰기로 해서 다시 하드 삭제로 돌렸다. 아카이브 UI/엔드포인트는
 * 호환을 위해 남아 있고(이미 purgedAt 이 찍힌 옛 행이 있을 수 있으므로 그건 그대로 보임), 새로
 * 영구삭제되는 건은 더는 아카이브로 안 쌓인다.
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
     * 이름은 호환을 위해 유지(호출부 그대로). 실제 동작: R2 파일 + Order 행을 같이 하드 삭제.
     */
    @Transactional
    public void purgeFilesKeepRecord(Order order) {
        purgeR2Files(order);                        // 반드시 행 삭제 전에 — 키 추출이 order/files 에서 됨
        orderRepository.delete(order);
        log.info("[Archive] order {} hard-deleted — R2 files removed, row removed", order.getOrderNumber());
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
