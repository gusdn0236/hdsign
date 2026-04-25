package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@RestController
@RequestMapping("/api/admin/orders")
@RequiredArgsConstructor
public class AdminOrderController {

    private final OrderRepository orderRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    // 전체 작업 목록 조회 (휴지통 제외, 최신순)
    @GetMapping
    public ResponseEntity<List<OrderDto.Response>> getAllOrders() {
        List<OrderDto.Response> orders = orderRepository.findByDeletedAtIsNullOrderByCreatedAtDesc()
                .stream()
                .map(OrderDto::toResponse)
                .toList();
        return ResponseEntity.ok(orders);
    }

    // 휴지통 목록 (삭제된 지 최근순)
    @GetMapping("/trash")
    public ResponseEntity<List<OrderDto.Response>> getTrash() {
        List<OrderDto.Response> orders = orderRepository.findByDeletedAtIsNotNullOrderByDeletedAtDesc()
                .stream()
                .map(OrderDto::toResponse)
                .toList();
        return ResponseEntity.ok(orders);
    }

    // 상태 변경
    @PutMapping("/{id}/status")
    public ResponseEntity<OrderDto.Response> updateStatus(
            @PathVariable Long id,
            @RequestBody OrderDto.StatusUpdateRequest req
    ) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        order.setStatus(Order.OrderStatus.valueOf(req.getStatus()));
        return ResponseEntity.ok(OrderDto.toResponse(orderRepository.save(order)));
    }

    // 완료 주문을 휴지통으로 이동 (soft delete)
    @DeleteMapping("/{id}")
    public ResponseEntity<?> moveToTrash(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "이미 휴지통에 있는 작업입니다."));
        }
        if (order.getStatus() != Order.OrderStatus.COMPLETED) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "완료된 작업만 휴지통으로 이동할 수 있습니다."));
        }

        order.setDeletedAt(LocalDateTime.now());
        orderRepository.save(order);
        return ResponseEntity.noContent().build();
    }

    // 휴지통에서 복원
    @PostMapping("/{id}/restore")
    public ResponseEntity<?> restoreFromTrash(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getDeletedAt() == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "휴지통에 없는 작업입니다."));
        }

        order.setDeletedAt(null);
        Order saved = orderRepository.save(order);
        return ResponseEntity.ok(OrderDto.toResponse(saved));
    }

    // 휴지통에서 영구 삭제 (R2 파일/미리보기 포함)
    @DeleteMapping("/{id}/permanent")
    public ResponseEntity<?> deletePermanently(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getDeletedAt() == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "휴지통에 있는 작업만 영구 삭제할 수 있습니다."));
        }

        purgeR2Files(order);
        orderRepository.delete(order);
        return ResponseEntity.noContent().build();
    }

    private void purgeR2Files(Order order) {
        List<String> keysToDelete = new ArrayList<>();
        for (OrderFile file : order.getFiles()) {
            if (file.getStoredName() != null && !file.getStoredName().isBlank()) {
                keysToDelete.add(file.getStoredName());
            }
            String previewKey = extractKeyFromPublicUrl(file.getPreviewUrl());
            if (previewKey != null) {
                keysToDelete.add(previewKey);
            }
        }

        for (String key : keysToDelete) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket)
                        .key(key)
                        .build());
            } catch (Exception ignored) {
                // best-effort
            }
        }
    }

    @GetMapping("/{id}/worksheet-package")
    public ResponseEntity<byte[]> downloadWorksheetPackage(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ZipOutputStream zos = new ZipOutputStream(baos, StandardCharsets.UTF_8);

            Map<String, Object> info = new LinkedHashMap<>();
            info.put("orderNumber", order.getOrderNumber());
            info.put("companyName", order.getClient().getCompanyName());
            info.put("contactName", order.getClient().getContactName());
            info.put("phone", order.getClient().getPhone());
            info.put("title", order.getTitle());
            info.put("requestType", order.getRequestType().name());
            info.put("dueDate", order.getDueDate() != null ? order.getDueDate().toString() : null);
            info.put("dueTime", order.getDueTime());
            info.put("deliveryMethod", order.getDeliveryMethod() != null ? deliveryLabel(order.getDeliveryMethod()) : null);
            info.put("deliveryAddress", order.getDeliveryAddress());
            info.put("additionalItems", order.getAdditionalItems());
            info.put("note", order.getNote());
            info.put("createdAt", order.getCreatedAt().toString());

            byte[] jsonBytes = new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsBytes(info);
            zos.putNextEntry(new ZipEntry(order.getOrderNumber() + ".json"));
            zos.write(jsonBytes);
            zos.closeEntry();

            for (OrderFile file : order.getFiles()) {
                if (file.getStoredName() == null || file.getStoredName().isBlank()) continue;
                try {
                    byte[] fileBytes = s3Client.getObjectAsBytes(
                            GetObjectRequest.builder().bucket(bucket).key(file.getStoredName()).build()
                    ).asByteArray();
                    String name = file.getOriginalName() != null ? file.getOriginalName() : file.getStoredName();
                    zos.putNextEntry(new ZipEntry(name));
                    zos.write(fileBytes);
                    zos.closeEntry();
                } catch (Exception ignored) {}
            }

            zos.finish();
            zos.close();

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            headers.set("Content-Disposition",
                    "attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(order.getOrderNumber() + "_지시서.zip", "UTF-8").replace("+", "%20"));
            return ResponseEntity.ok().headers(headers).body(baos.toByteArray());

        } catch (Exception e) {
            throw new RuntimeException("지시서 패키지 생성 실패: " + e.getMessage());
        }
    }

    private String deliveryLabel(Order.DeliveryMethod method) {
        return switch (method) {
            case CARGO -> "화물 발송";
            case QUICK -> "퀵 발송";
            case DIRECT -> "직접 배송";
            case PICKUP -> "직접 수령";
        };
    }

    private String extractKeyFromPublicUrl(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;

        String normalizedBase = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(normalizedBase)) return null;
        return url.substring(normalizedBase.length());
    }
}
