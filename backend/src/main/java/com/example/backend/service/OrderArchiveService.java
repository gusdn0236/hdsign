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

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * "영구삭제" 의 실제 동작 — 휴지통에서 관리자가 [영구삭제] 를 누르거나 휴지통에 들어간 지
 * 30일이 지나 자동으로 정리될 때 호출. R2 의 도안 원본·미리보기·지시서 PDF(평탄화/원본)·
 * 썸네일을 전부 지우고 order_files 행도 제거한 뒤, 현장 프로그램이 옛 지시서를 다시
 * 찾는 데 필요한 최소 정보(거래처·제목·발주일·납기·사양메모·originalPdfFilename)만 남긴 채
 * purgedAt 을 찍는다. Order 행 자체는 보존 — 진짜 행 삭제는 관리자 아카이브 [완전삭제] 에서만.
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
     * 호출 측에서 별도 save 불필요(여기서 save 한다). 멱등 — 이미 purgedAt 이 찍힌 건은 손대지 않음.
     */
    @Transactional
    public void purgeFilesKeepRecord(Order order) {
        if (order.getPurgedAt() != null) return;   // 이미 아카이브됨

        purgeR2Files(order);                        // 반드시 files 비우기 전에
        order.getFiles().clear();                   // orphanRemoval → order_files 행 삭제
        order.setWorksheetPdfUrl(null);
        order.setWorksheetOriginalPdfUrl(null);
        order.setWorksheetThumbnailUrl(null);
        order.setWorksheetChangeNote(null);         // "최신 변경분" 텍스트 — 파일이 없으면 의미 없음
        if (order.getDeletedAt() == null) order.setDeletedAt(LocalDateTime.now());
        order.setPurgedAt(LocalDateTime.now());
        orderRepository.save(order);
        log.info("[Archive] order {} purged — R2 files removed, minimal record kept", order.getOrderNumber());
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
