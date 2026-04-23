package com.example.backend.dto;

import com.example.backend.entity.Order;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

public class OrderDto {

    @Getter
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Response {
        private Long id;
        private String orderNumber;
        private String requestType;
        private String clientCompanyName;
        private String title;
        private Boolean hasSMPS;
        private String additionalItems;
        private String note;
        private LocalDate dueDate;
        private String dueTime;
        private String deliveryMethod;
        private String deliveryAddress;
        private String status;
        private List<FileInfo> files;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
    }

    @Getter
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileInfo {
        private Long id;
        private String originalName;
        private String fileUrl;
        private String previewUrl;
        private Long fileSize;
        private String contentType;
    }

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    public static class StatusUpdateRequest {
        private String status;
    }

    public static Response toResponse(Order order) {
        List<FileInfo> files = order.getFiles().stream()
                .map(file -> FileInfo.builder()
                        .id(file.getId())
                        .originalName(file.getOriginalName())
                        .fileUrl(file.getFileUrl())
                        .previewUrl(file.getPreviewUrl())
                        .fileSize(file.getFileSize())
                        .contentType(file.getContentType())
                        .build())
                .toList();

        return Response.builder()
                .id(order.getId())
                .orderNumber(order.getOrderNumber())
                .requestType(order.getRequestType().name())
                .clientCompanyName(order.getClient() != null ? order.getClient().getCompanyName() : null)
                .title(order.getTitle())
                .hasSMPS(order.getHasSMPS())
                .additionalItems(order.getAdditionalItems())
                .note(order.getNote())
                .dueDate(order.getDueDate())
                .dueTime(order.getDueTime())
                .deliveryMethod(order.getDeliveryMethod() != null ? order.getDeliveryMethod().name() : null)
                .deliveryAddress(order.getDeliveryAddress())
                .status(order.getStatus().name())
                .files(files)
                .createdAt(order.getCreatedAt())
                .updatedAt(order.getUpdatedAt())
                .build();
    }
}
