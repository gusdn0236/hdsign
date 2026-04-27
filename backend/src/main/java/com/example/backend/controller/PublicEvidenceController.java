package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderFileRepository;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 작업지시서 QR을 스캔한 휴대폰에서 증거 사진을 업로드하는 공개 엔드포인트.
 * 인증이 필요 없는 대신, 작업지시서를 물리적으로 가진 직원만 URL을 알 수 있다는 가정.
 */
@Slf4j
@RestController
@RequestMapping("/api/public/orders")
@RequiredArgsConstructor
public class PublicEvidenceController {

    private final OrderRepository orderRepository;
    private final OrderFileRepository orderFileRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    @GetMapping("/{orderNumber}/summary")
    public ResponseEntity<?> getOrderSummary(@PathVariable String orderNumber) {
        return orderRepository.findByOrderNumber(orderNumber)
                .map(order -> {
                    Map<String, Object> body = new HashMap<>();
                    body.put("orderNumber", order.getOrderNumber());
                    body.put("title", order.getTitle());
                    body.put("companyName", order.getClient() != null ? order.getClient().getCompanyName() : null);
                    body.put("status", order.getStatus().name());
                    return ResponseEntity.ok(body);
                })
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다.")));
    }

    @PostMapping("/{orderNumber}/evidence")
    public ResponseEntity<?> uploadEvidence(
            @PathVariable String orderNumber,
            @RequestParam(required = false) String department,
            @RequestParam("files") List<MultipartFile> files
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (files == null || files.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "사진을 선택해 주세요."));
        }

        String dept = department == null ? null : department.trim();
        if (dept != null && dept.isEmpty()) dept = null;
        if (dept != null && dept.length() > 100) dept = dept.substring(0, 100);

        List<OrderDto.FileInfo> uploaded = new ArrayList<>();
        String normalizedPublicUrl = publicUrl == null || publicUrl.isBlank()
                ? ""
                : (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");

        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) continue;

            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) {
                originalName = "evidence.jpg";
            }
            String extension = originalName.contains(".")
                    ? originalName.substring(originalName.lastIndexOf("."))
                    : ".jpg";
            String key = "orders/" + order.getOrderNumber() + "/evidence/" + UUID.randomUUID() + extension;

            try {
                s3Client.putObject(
                        PutObjectRequest.builder()
                                .bucket(bucket)
                                .key(key)
                                .contentType(file.getContentType() != null ? file.getContentType() : "image/jpeg")
                                .build(),
                        RequestBody.fromBytes(file.getBytes())
                );
            } catch (Exception e) {
                log.warn("증거 사진 업로드 실패 [{}/{}]: {}", order.getOrderNumber(), originalName, e.getMessage());
                continue;
            }

            OrderFile saved = orderFileRepository.save(OrderFile.builder()
                    .order(order)
                    .originalName(originalName)
                    .storedName(key)
                    .fileUrl(normalizedPublicUrl + key)
                    .fileSize(file.getSize())
                    .contentType(file.getContentType())
                    .isEvidence(true)
                    .uploadedDepartment(dept)
                    .build());

            uploaded.add(OrderDto.FileInfo.builder()
                    .id(saved.getId())
                    .originalName(saved.getOriginalName())
                    .fileUrl(saved.getFileUrl())
                    .previewUrl(saved.getPreviewUrl())
                    .fileSize(saved.getFileSize())
                    .contentType(saved.getContentType())
                    .isEvidence(true)
                    .uploadedDepartment(saved.getUploadedDepartment())
                    .createdAt(saved.getCreatedAt())
                    .build());
        }

        if (uploaded.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("message", "사진 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요."));
        }

        // 관리자 페이지 행 배지 트리거. adminViewedAt 보다 이 시각이 늦으면 "신규 사진" 표시.
        order.setEvidenceLastUploadedAt(LocalDateTime.now());
        orderRepository.save(order);

        Map<String, Object> body = new HashMap<>();
        body.put("uploaded", uploaded);
        body.put("count", uploaded.size());
        return ResponseEntity.ok(body);
    }

    /**
     * FlexSign 인쇄 시점에 작업자가 다이얼로그로 확정한 최종 납기 일자/배송방법을 PATCH.
     * 워처가 보내는 본문 예: { "dueDate": "yyyy-MM-dd", "deliveryMethod": "CARGO" }
     * 둘 다 옵션이지만 둘 다 비어있으면 400. 잘못된 포맷도 400.
     * 엔드포인트 이름은 "/due-date" 그대로 유지 — 기존 워처 빌드와의 호환성을 위해.
     */
    @PostMapping("/{orderNumber}/due-date")
    public ResponseEntity<?> updateDueDate(
            @PathVariable String orderNumber,
            @org.springframework.web.bind.annotation.RequestBody Map<String, Object> body
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (body == null) body = Map.of();

        String dueRaw = body.get("dueDate") instanceof String s ? s : null;
        String deliveryRaw = body.get("deliveryMethod") instanceof String s ? s : null;
        Object tagsObj = body.get("departmentTags");
        boolean hasDue = dueRaw != null && !dueRaw.isBlank();
        boolean hasDelivery = deliveryRaw != null && !deliveryRaw.isBlank();
        // tagsObj 가 List 면 명시적 갱신 의도(빈 배열도 "태그 비우기" 의도). 키 자체가 없으면 갱신 안 함.
        boolean hasTags = tagsObj instanceof List<?>;
        if (!hasDue && !hasDelivery && !hasTags) {
            return ResponseEntity.badRequest().body(Map.of("message", "dueDate / deliveryMethod / departmentTags 중 하나는 있어야 합니다."));
        }

        // 실제로 값이 바뀌었는지 비교 — 같은 값으로 PATCH 가 와도 "변경" 배지를 띄우지 않기 위해.
        boolean changed = false;

        if (hasDue) {
            LocalDate parsed;
            try {
                parsed = LocalDate.parse(dueRaw.trim());
            } catch (DateTimeParseException e) {
                return ResponseEntity.badRequest().body(Map.of("message", "dueDate 포맷은 yyyy-MM-dd 입니다."));
            }
            if (!parsed.equals(order.getDueDate())) {
                order.setDueDate(parsed);
                changed = true;
            }
        }

        if (hasDelivery) {
            Order.DeliveryMethod parsedDelivery;
            try {
                parsedDelivery = Order.DeliveryMethod.valueOf(deliveryRaw.trim());
            } catch (IllegalArgumentException e) {
                return ResponseEntity.badRequest().body(Map.of("message", "deliveryMethod 가 유효하지 않습니다 (CARGO/QUICK/DIRECT/PICKUP/LOCAL_CARGO)."));
            }
            if (parsedDelivery != order.getDeliveryMethod()) {
                order.setDeliveryMethod(parsedDelivery);
                changed = true;
            }
        }

        // 부서 태그 갱신 — 모바일 뷰어 필터에만 영향. 배부 변경은 "변경" 배지 트리거 X
        // (작업 내용/납기/배송이 안 바뀌었으면 거래처/관리자 입장에선 알릴 게 없음).
        if (hasTags) {
            String csv = ((List<?>) tagsObj).stream()
                    .filter(java.util.Objects::nonNull)
                    .map(Object::toString)
                    .map(String::trim)
                    .filter(t -> !t.isEmpty())
                    .distinct()
                    .collect(java.util.stream.Collectors.joining(","));
            String oldCsv = order.getDepartmentTags() == null ? "" : order.getDepartmentTags();
            if (!csv.equals(oldCsv)) {
                order.setDepartmentTags(csv.isEmpty() ? null : csv);
            }
        }

        // 실제 변경이 발생했을 때만 배지 트리거. (태그 변경은 changed 에 포함하지 않음)
        if (changed) {
            order.setWorksheetUpdatedAt(LocalDateTime.now());
        }

        orderRepository.save(order);
        Map<String, Object> resp = new HashMap<>();
        resp.put("orderNumber", order.getOrderNumber());
        resp.put("dueDate", order.getDueDate() != null ? order.getDueDate().toString() : null);
        resp.put("deliveryMethod", order.getDeliveryMethod() != null ? order.getDeliveryMethod().name() : null);
        resp.put("departmentTags", splitTags(order.getDepartmentTags()));
        return ResponseEntity.ok(resp);
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

    /**
     * 워처가 변환 직후 같이 만들어 보내는 지시서 PDF.
     * 주문 1건당 항상 최신 1개만 유지(덮어쓰기). 거래처 작업현황 화면 맨 위에 노출된다.
     */
    @PostMapping("/{orderNumber}/worksheet-pdf")
    public ResponseEntity<?> uploadWorksheetPdf(
            @PathVariable String orderNumber,
            @RequestParam("file") MultipartFile file,
            // 워처 인쇄 다이얼로그에서 사용자가 "지시서 내용 변경됨" 체크박스를 켰을 때 true.
            // 단순 재인쇄(동일 내용)로 인한 PDF 재업로드는 false → 배지 안 띄움.
            @RequestParam(value = "contentChanged", required = false) Boolean contentChanged,
            // 작업자가 "지시서 내용 변경" 분기에서 입력한 변경 메모.
            // 모바일 뷰어에서 PDF 한 번 탭하면 이 텍스트가 떠서 작업자가 즉시 확인.
            // contentChanged=true 일 때만 저장하고, 그 외(신규/납기단순변경)에는 비운다.
            @RequestParam(value = "changeNote", required = false) String changeNote
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "PDF 파일이 비어 있습니다."));
        }

        // 새 PDF 업로드 전에 이전 PDF 키를 미리 잡아둔다 — 업로드/저장 성공 후 best-effort 로 삭제.
        // 실패해도 서비스 흐름엔 영향 없고 다음 영구삭제 시 정리되도록 keysToDelete 가 누적되지 않게
        // 매번 즉시 시도. 새 업로드가 실패하면 옛 PDF 가 그대로 남아 fallback 으로 사용 가능.
        String oldWorksheetKey = extractKeyFromPublicUrl(order.getWorksheetPdfUrl());

        String key = "orders/" + order.getOrderNumber() + "/worksheet/" + UUID.randomUUID() + ".pdf";
        try {
            s3Client.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(key)
                            .contentType("application/pdf")
                            .build(),
                    RequestBody.fromBytes(file.getBytes())
            );
        } catch (Exception e) {
            log.warn("지시서 PDF 업로드 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("message", "PDF 업로드에 실패했습니다."));
        }

        String normalizedPublicUrl = publicUrl == null || publicUrl.isBlank()
                ? ""
                : (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");
        String url = normalizedPublicUrl + key;

        // 첫 부착(이전 URL 이 없었음) 또는 사용자가 "지시서 내용 변경됨" 체크박스를 켰을 때만
        // "변경" 배지 트리거. 단순 재인쇄(동일 내용)는 배지 안 띄움.
        // 납기/배송 실제 변경은 /due-date 에서 별도로 잡는다.
        boolean firstAttachment = order.getWorksheetPdfUrl() == null || order.getWorksheetPdfUrl().isBlank();
        boolean userMarkedChanged = Boolean.TRUE.equals(contentChanged);
        order.setWorksheetPdfUrl(url);
        if (firstAttachment || userMarkedChanged) {
            order.setWorksheetUpdatedAt(LocalDateTime.now());
        }
        // changeNote 는 "최신 변경분만" 보이도록 매 업로드마다 다시 산출한다.
        // 내용변경(체크박스 ON) 일 때만 새 메모를 저장하고, 그 외(신규작성·단순 재인쇄)는 비운다.
        if (userMarkedChanged) {
            String trimmed = changeNote == null ? "" : changeNote.trim();
            if (trimmed.length() > 2000) trimmed = trimmed.substring(0, 2000);
            order.setWorksheetChangeNote(trimmed.isEmpty() ? null : trimmed);
        } else {
            order.setWorksheetChangeNote(null);
        }
        orderRepository.save(order);

        // DB 가 새 URL 로 바뀐 직후 옛 R2 객체 삭제(best-effort). 실패해도 다음 영구삭제 시 청소됨.
        if (oldWorksheetKey != null && !oldWorksheetKey.equals(key)) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket).key(oldWorksheetKey).build());
            } catch (Exception e) {
                log.warn("이전 지시서 PDF 삭제 실패 [{}/{}]: {}",
                        order.getOrderNumber(), oldWorksheetKey, e.getMessage());
            }
        }

        return ResponseEntity.ok(Map.of(
                "orderNumber", order.getOrderNumber(),
                "worksheetPdfUrl", url
        ));
    }

    private String extractKeyFromPublicUrl(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;
        String base = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(base)) return null;
        return url.substring(base.length());
    }

    /**
     * 워처(hdsign_worksheet.exe)가 ZIP을 받아 AI에 QR을 박고 v8 저장한 뒤 호출.
     * RECEIVED 상태인 주문만 IN_PROGRESS로 전환한다(이미 작업중/완료면 무시).
     * 워처가 안 켜져 있으면 이 호출 자체가 일어나지 않으므로, 상태는 그대로 RECEIVED 유지된다.
     */
    @PostMapping("/{orderNumber}/worksheet-acknowledged")
    public ResponseEntity<?> acknowledgeWorksheet(@PathVariable String orderNumber) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (order.getStatus() == Order.OrderStatus.RECEIVED) {
            order.setStatus(Order.OrderStatus.IN_PROGRESS);
            orderRepository.save(order);
        }
        return ResponseEntity.ok(Map.of(
                "orderNumber", order.getOrderNumber(),
                "status", order.getStatus().name()
        ));
    }
}
