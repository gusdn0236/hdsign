package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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

    // 전체 작업 목록 조회 (최신순)
    @GetMapping
    public ResponseEntity<List<OrderDto.Response>> getAllOrders() {
        List<OrderDto.Response> orders = orderRepository.findAllByOrderByCreatedAtDesc()
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

    // 완료 주문 삭제 (R2 파일/미리보기 포함)
    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteOrder(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getStatus() != Order.OrderStatus.COMPLETED) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "완료된 작업만 삭제할 수 있습니다."));
        }

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
                // 파일 삭제는 best-effort 처리: DB 삭제는 계속 진행
            }
        }

        orderRepository.delete(order);
        return ResponseEntity.noContent().build();
    }

    private String extractKeyFromPublicUrl(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;

        String normalizedBase = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(normalizedBase)) return null;
        return url.substring(normalizedBase.length());
    }
}
