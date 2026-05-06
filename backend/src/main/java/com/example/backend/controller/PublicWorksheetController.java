package com.example.backend.controller;

import com.example.backend.entity.Order;
import com.example.backend.entity.WorkerCompletion;
import com.example.backend.repository.OrderRepository;
import com.example.backend.repository.WorkerCompletionRepository;
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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
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
    private final WorkerCompletionRepository workerCompletionRepository;
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
    public ResponseEntity<?> proxyPdf(
            @PathVariable String orderNumber,
            @RequestHeader(value = "User-Agent", required = false) String userAgent
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null || order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String pdfUrl = shouldServeOriginalPdf(userAgent)
                ? firstNonBlank(order.getWorksheetOriginalPdfUrl(), order.getWorksheetPdfUrl())
                : firstNonBlank(order.getWorksheetPdfUrl(), order.getWorksheetOriginalPdfUrl());
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

    /**
     * 썸네일 JPEG 프록시 — PDF 프록시(/pdf) 와 동일 패턴. R2 가 워처 PC 의 직접 GET 을 403 으로
     * 막는 환경에서 백엔드를 거쳐 받게 한다(CORS/access policy 무관). 워처 [기존 변경] 탭 그리드의
     * 1차 빠른 로드를 항상 성공시키는 게 목적 — 실패하면 PDF 폴백으로 5~10배 느려졌었음.
     */
    @GetMapping("/{orderNumber}/thumbnail")
    public ResponseEntity<?> proxyThumbnail(@PathVariable String orderNumber) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null || order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String thumbUrl = order.getWorksheetThumbnailUrl();
        if (thumbUrl == null || thumbUrl.isBlank()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String key = extractKey(thumbUrl);
        if (key == null) {
            log.warn("썸네일 프록시 — key 추출 실패 [{}], url={}", orderNumber, thumbUrl);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        try {
            ResponseInputStream<GetObjectResponse> stream = s3Client.getObject(
                    GetObjectRequest.builder().bucket(bucket).key(key).build()
            );
            long contentLength = stream.response().contentLength();
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.IMAGE_JPEG);
            headers.setContentLength(contentLength);
            // 썸네일은 worksheetUpdatedAt 갱신 시 R2 키 자체가 바뀌므로 길게 캐시해도 안전.
            headers.setCacheControl("public, max-age=600");
            headers.setContentDispositionFormData("inline", "worksheet-thumb.jpg");
            return new ResponseEntity<>(new InputStreamResource(stream), headers, HttpStatus.OK);
        } catch (Exception e) {
            log.warn("썸네일 프록시 실패 [{}/{}]: {}", orderNumber, key, e.getMessage());
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
        // 모바일 카드 빠른 로딩용 — 백엔드가 PDF 업로드 시 PDFBox 로 미리 만든 작은 JPEG.
        // null 이면 프론트가 기존 PDF 직접 렌더로 폴백.
        item.put("worksheetThumbnailUrl", o.getWorksheetThumbnailUrl());
        item.put("status", o.getStatus().name());
        item.put("worksheetUpdatedAt", o.getWorksheetUpdatedAt() != null ? o.getWorksheetUpdatedAt().toString() : null);
        item.put("evidenceLastUploadedAt", o.getEvidenceLastUploadedAt() != null ? o.getEvidenceLastUploadedAt().toString() : null);
        // 카드에서 D-day 표시용. 음수면 지난 납기.
        if (o.getDueDate() != null) {
            item.put("daysUntilDue", today.until(o.getDueDate()).getDays());
        }
        // 모바일 뷰어 부서 필터용 태그. 워처 인쇄 다이얼로그에서 분배함 칸 클릭으로 지정.
        item.put("departmentTags", splitTags(o.getDepartmentTags()));
        // 워처가 다이얼로그에서 "이전 클릭 슬롯 그대로" 복원하기 위한 라벨 단위 저장본.
        // 모바일 뷰어는 사용 안 함(부서 필터는 위 departmentTags 만 본다).
        item.put("departmentSlots", splitTags(o.getDepartmentSlots()));
        // 워처 다이얼로그에서 "변경된 내용" 텍스트 박스를 이전에 입력한 메모로 그대로 복원하기 위함.
        // 모바일 뷰어는 detail 엔드포인트에서 별도로 받아 PDF 탭 시 노출 — list 와 detail 양쪽에 노출.
        item.put("worksheetChangeNote", o.getWorksheetChangeNote());
        // per-worker 완료 신고 목록. 모바일은 자기 worker 가 이 안에 있는지 체크해 본인 리스트에서만
        // 제외(다른 직원에겐 그대로 보임). 작업현황 탭은 이 목록을 직원별 카드로 펼친다.
        List<Map<String, Object>> wcs = new ArrayList<>();
        for (WorkerCompletion wc : o.getWorkerCompletions()) {
            Map<String, Object> entry = new HashMap<>();
            entry.put("worker", wc.getWorker());
            entry.put("completedAt", wc.getCompletedAt() != null ? wc.getCompletedAt().toString() : null);
            wcs.add(entry);
        }
        item.put("workerCompletions", wcs);
        return item;
    }

    /**
     * 모바일 [작업완료] — 직원이 본인 작업이 끝났음을 신고. per-worker independent.
     * body: { "worker": "신문식" }. 인증 없음(IN_PROGRESS PDF 노출과 동일한 보안 수준).
     *
     * <p>같은 직원이 같은 지시서를 두 번 누르면 두 번째는 멱등(no-op). 다른 직원이 같은 지시서를
     * 누르면 row 가 추가됨 — 다른 직원에게는 영향 없음(같은 슬롯 동료라도 그대로 보임).
     */
    @PostMapping("/{orderNumber}/worker-complete")
    public ResponseEntity<?> workerComplete(
            @PathVariable String orderNumber,
            @RequestBody Map<String, Object> body
    ) {
        String worker = body == null ? null : (body.get("worker") instanceof String s ? s.trim() : null);
        if (worker == null || worker.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "worker 이름이 필요합니다."));
        }
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null || order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (order.getStatus() == Order.OrderStatus.COMPLETED) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "이미 마감된 작업입니다."));
        }
        // (order, worker) 기준 멱등 — 같은 직원이 또 누르면 무시. 다른 직원의 row 는 그대로.
        var existing = workerCompletionRepository.findByOrder_IdAndWorker(order.getId(), worker);
        if (existing.isEmpty()) {
            WorkerCompletion wc = WorkerCompletion.builder()
                    .order(order)
                    .worker(worker)
                    .build();
            workerCompletionRepository.save(wc);
            log.info("작업완료 신고 [{}] by {}", orderNumber, worker);
        }
        return ResponseEntity.ok(Map.of(
                "orderNumber", orderNumber,
                "worker", worker
        ));
    }

    private static boolean shouldServeOriginalPdf(String userAgent) {
        if (userAgent == null || userAgent.isBlank()) return false;
        String ua = userAgent.toLowerCase();
        return ua.contains("iphone")
                || ua.contains("ipad")
                || ua.contains("ipod")
                || (ua.contains("macintosh") && ua.contains("mobile") && ua.contains("safari"));
    }

    private static String firstNonBlank(String primary, String fallback) {
        if (primary != null && !primary.isBlank()) return primary;
        if (fallback != null && !fallback.isBlank()) return fallback;
        return null;
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
