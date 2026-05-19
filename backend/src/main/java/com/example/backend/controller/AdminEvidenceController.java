package com.example.backend.controller;

import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderFileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 관리자 페이지 "현장증거사진" 탭 전용.
 * QR 모바일 카메라로 들어온 사진(=OrderFile.isEvidence=true)만 거래처/기간 필터 + 페이지네이션으로 반환.
 */
@Slf4j
@RestController
@RequestMapping("/api/admin/evidence")
@RequiredArgsConstructor
public class AdminEvidenceController {

    private final OrderFileRepository orderFileRepository;

    @GetMapping
    public ResponseEntity<?> listEvidence(
            @RequestParam(required = false) Long clientId,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "60") int size
    ) {
        if (size > 200) size = 200;
        if (size < 1) size = 60;
        if (page < 0) page = 0;

        LocalDateTime fromDt = parseDateStart(from);
        LocalDateTime toDt = parseDateExclusiveEnd(to);

        Pageable pageable = PageRequest.of(page, size);
        Page<OrderFile> result = orderFileRepository.findEvidence(clientId, fromDt, toDt, pageable);

        List<Map<String, Object>> items = result.getContent().stream()
                .map(AdminEvidenceController::toItem)
                .toList();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("content", items);
        body.put("page", result.getNumber());
        body.put("size", result.getSize());
        body.put("totalElements", result.getTotalElements());
        body.put("totalPages", result.getTotalPages());
        body.put("hasNext", result.hasNext());
        return ResponseEntity.ok(body);
    }

    private static Map<String, Object> toItem(OrderFile f) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", f.getId());
        m.put("fileUrl", f.getFileUrl());
        m.put("originalName", f.getOriginalName());
        m.put("fileSize", f.getFileSize());
        m.put("contentType", f.getContentType());
        m.put("uploadedDepartment", f.getUploadedDepartment());
        m.put("createdAt", f.getCreatedAt());
        if (f.getOrder() != null) {
            m.put("orderId", f.getOrder().getId());
            m.put("orderNumber", f.getOrder().getOrderNumber());
            m.put("orderTitle", f.getOrder().getTitle());
            if (f.getOrder().getClient() != null) {
                m.put("clientId", f.getOrder().getClient().getId());
                m.put("companyName", f.getOrder().getClient().getCompanyName());
            }
        }
        return m;
    }

    private static LocalDateTime parseDateStart(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return LocalDate.parse(s.trim()).atStartOfDay();
        } catch (Exception e) {
            return null;
        }
    }

    /** 끝 날짜는 "그 다음 날 00:00"으로 변환해 종일 포함하는 [from, end) 반열린 구간으로. */
    private static LocalDateTime parseDateExclusiveEnd(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return LocalDate.parse(s.trim()).plusDays(1).atStartOfDay();
        } catch (Exception e) {
            return null;
        }
    }
}
