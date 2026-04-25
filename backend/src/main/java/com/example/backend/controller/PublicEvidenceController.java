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
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

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

        return ResponseEntity.ok(Map.of(
                "orderNumber", order.getOrderNumber(),
                "worksheetPdfUrl", url
        ));
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
