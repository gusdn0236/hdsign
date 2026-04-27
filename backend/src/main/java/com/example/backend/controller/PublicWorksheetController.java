package com.example.backend.controller;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

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
@Slf4j
@RestController
@RequestMapping("/api/public/worksheets")
@RequiredArgsConstructor
public class PublicWorksheetController {

    private final OrderRepository orderRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

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
                    // 모바일 뷰어 PDF 한번 탭 시 노출되는 "변경사항 텍스트".
                    // null/빈문자면 모바일에서 추가요청사항(note) 으로 폴백.
                    body.put("worksheetChangeNote", o.getWorksheetChangeNote());
                    return ResponseEntity.ok(body);
                })
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다.")));
    }

    /**
     * PDF 프록시 — R2 의 PDF 를 서버 사이드에서 가져와 같은 출처(백엔드) 로 응답.
     * R2 버킷 자체에 CORS 를 안 열어도 fetch 기반 PDF.js 가 바이트를 받을 수 있게 함.
     * 인증 없음 — 어차피 R2 public URL 도 무인증이라 보안 수준은 동일.
     */
    @GetMapping("/{orderNumber}/pdf")
    public ResponseEntity<?> proxyPdf(@PathVariable String orderNumber) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null || order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String pdfUrl = order.getWorksheetPdfUrl();
        if (pdfUrl == null || pdfUrl.isBlank()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String key = extractKey(pdfUrl);
        if (key == null) {
            log.warn("PDF 프록시 — key 추출 실패 [{}], url={}", orderNumber, pdfUrl);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }

        try {
            ResponseInputStream<GetObjectResponse> stream = s3Client.getObject(
                    GetObjectRequest.builder().bucket(bucket).key(key).build()
            );
            long contentLength = stream.response().contentLength();
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_PDF);
            headers.setContentLength(contentLength);
            // 워처가 같은 주문에 대해 PDF 를 재업로드하면 worksheetPdfUrl(R2 키) 자체가 바뀌므로
            // 같은 프록시 URL 응답이 짧게 stale 해도 다음 fetch 시 새 PDF 가 자동으로 보인다.
            // 5분 캐시 — 같은 사용자가 반복 조회할 때 트래픽 절감 (워처 재인쇄 → 5분 내 반영).
            headers.setCacheControl("public, max-age=300");
            // 인라인 표시(첨부 다운로드 X).
            headers.setContentDispositionFormData("inline", "worksheet.pdf");
            return new ResponseEntity<>(new InputStreamResource(stream), headers, HttpStatus.OK);
        } catch (Exception e) {
            log.warn("PDF 프록시 실패 [{}/{}]: {}", orderNumber, key, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    private String extractKey(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;
        String base = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(base)) return null;
        return url.substring(base.length());
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
        // 모바일 뷰어 부서 필터용 태그. 워처 인쇄 다이얼로그에서 분배함 칸 클릭으로 지정.
        item.put("departmentTags", splitTags(o.getDepartmentTags()));
        return item;
    }

    private static List<String> splitTags(String csv) {
        if (csv == null || csv.isBlank()) return List.of();
        List<String> out = new ArrayList<>();
        for (String part : csv.split(",")) {
            String t = part.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }
}
