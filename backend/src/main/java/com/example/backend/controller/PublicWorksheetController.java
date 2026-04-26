package com.example.backend.controller;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 휴대폰 모바일 지시서 뷰어(/m/worksheets) 용 공개 엔드포인트.
 * 무인증 — 회사 와이파이/현장 휴대폰에서 바로 열 수 있어야 하므로.
 *
 * 노출 조건: 작업지시서가 출력된 이후의 "진행중(IN_PROGRESS)" 주문만.
 *  - 접수완료(RECEIVED): 아직 워처가 처리 안 했거나 출력 전 — 모바일에 노출 X
 *  - 진행중(IN_PROGRESS): 출력 → 작업 진행 단계 — 모바일 노출 ✓
 *  - 완료(COMPLETED): 끝난 작업 — 모바일에 노출 X
 *
 * worksheetPdfUrl 도 추가로 검사 — 이론상 IN_PROGRESS 면 PDF 가 있어야 하지만
 * 워처 흐름의 엣지케이스로 PDF 없이 IN_PROGRESS 가 되는 경우 모바일에서는 표시 무의미.
 */
@RestController
@RequestMapping("/api/public/worksheets")
@RequiredArgsConstructor
public class PublicWorksheetController {

    private final OrderRepository orderRepository;

    @GetMapping
    public ResponseEntity<?> list() {
        LocalDate today = LocalDate.now();
        List<Map<String, Object>> body = new ArrayList<>();

        List<Order> all = orderRepository.findByDeletedAtIsNullOrderByCreatedAtDesc();
        all.stream()
                .filter(o -> o.getStatus() == Order.OrderStatus.IN_PROGRESS)
                .filter(o -> o.getWorksheetPdfUrl() != null && !o.getWorksheetPdfUrl().isBlank())
                .sorted(Comparator
                        // 납기 임박 순. null 납기는 뒤로.
                        .comparing((Order o) -> o.getDueDate() == null ? LocalDate.MAX : o.getDueDate())
                        .thenComparing(Order::getCreatedAt, Comparator.reverseOrder()))
                .forEach(o -> body.add(toSummary(o, today)));

        return ResponseEntity.ok(body);
    }

    @GetMapping("/{orderNumber}")
    public ResponseEntity<?> detail(@PathVariable String orderNumber) {
        return orderRepository.findByOrderNumber(orderNumber)
                .filter(o -> o.getDeletedAt() == null)
                .<ResponseEntity<?>>map(o -> {
                    Map<String, Object> body = toSummary(o, LocalDate.now());
                    body.put("note", o.getNote());
                    body.put("additionalItems", o.getAdditionalItems());
                    body.put("hasSMPS", o.getHasSMPS());
                    return ResponseEntity.ok(body);
                })
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다.")));
    }

    private Map<String, Object> toSummary(Order o, LocalDate today) {
        Map<String, Object> item = new HashMap<>();
        item.put("orderNumber", o.getOrderNumber());
        item.put("title", o.getTitle());
        item.put("companyName", o.getClient() != null ? o.getClient().getCompanyName() : null);
        item.put("dueDate", o.getDueDate() != null ? o.getDueDate().toString() : null);
        item.put("dueTime", o.getDueTime());
        item.put("deliveryMethod", o.getDeliveryMethod() != null ? o.getDeliveryMethod().name() : null);
        item.put("worksheetPdfUrl", o.getWorksheetPdfUrl());
        item.put("status", o.getStatus().name());
        item.put("worksheetUpdatedAt", o.getWorksheetUpdatedAt() != null ? o.getWorksheetUpdatedAt().toString() : null);
        item.put("evidenceLastUploadedAt", o.getEvidenceLastUploadedAt() != null ? o.getEvidenceLastUploadedAt().toString() : null);
        // 카드에서 D-day 표시용. 음수면 지난 납기.
        if (o.getDueDate() != null) {
            item.put("daysUntilDue", today.until(o.getDueDate()).getDays());
        }
        return item;
    }
}
