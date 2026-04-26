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
            @org.springframework.web.bind.annotation.RequestBody Map<String, String> body
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (body == null) body = Map.of();

        String dueRaw = body.get("dueDate");
        String deliveryRaw = body.get("deliveryMethod");
        boolean hasDue = dueRaw != null && !dueRaw.isBlank();
        boolean hasDelivery = deliveryRaw != null && !deliveryRaw.isBlank();
        if (!hasDue && !hasDelivery) {
            return ResponseEntity.badRequest().body(Map.of("message", "dueDate 또는 deliveryMethod 중 하나는 있어야 합니다."));
        }

        if (hasDue) {
            try {
                order.setDueDate(LocalDate.parse(dueRaw.trim()));
            } catch (DateTimeParseException e) {
                return ResponseEntity.badRequest().body(Map.of("message", "dueDate 포맷은 yyyy-MM-dd 입니다."));
            }
        }

        if (hasDelivery) {
            try {
                order.setDeliveryMethod(Order.DeliveryMethod.valueOf(deliveryRaw.trim()));
            } catch (IllegalArgumentException e) {
                return ResponseEntity.badRequest().body(Map.of("message", "deliveryMethod 가 유효하지 않습니다 (CARGO/QUICK/DIRECT/PICKUP/LOCAL_CARGO)."));
            }
        }

        orderRepository.save(order);
        Map<String, Object> resp = new HashMap<>();
        resp.put("orderNumber", order.getOrderNumber());
        resp.put("dueDate", order.getDueDate() != null ? order.getDueDate().toString() : null);
        resp.put("deliveryMethod", order.getDeliveryMethod() != null ? order.getDeliveryMethod().name() : null);
        return ResponseEntity.ok(resp);
    }

    /**
     * 워처가 변환 직후 같이 만들어 보내는 지시서 PDF.
     * 주문 1건당 항상 최신 1개만 유지(덮어쓰기). 거래처 작업현황 화면 맨 위에 노출된다.
     */
    @PostMapping("/{orderNumber}/worksheet-pdf")
    public ResponseEntity<?> uploadWorksheetPdf(
            @PathVariable String orderNumber,
            @RequestParam("file") MultipartFile file
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
        order.setWorksheetPdfUrl(url);
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
