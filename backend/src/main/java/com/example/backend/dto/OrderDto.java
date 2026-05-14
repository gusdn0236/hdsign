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
        private String worksheetPdfUrl;
        private String worksheetOriginalPdfUrl;
        private String worksheetThumbnailUrl;
        private LocalDateTime evidenceLastUploadedAt;
        private LocalDateTime worksheetUpdatedAt;
        private String worksheetChangeNote;
        private LocalDateTime adminViewedAt;
        // per-worker 완료 신고 목록. 같은 지시서를 여러 직원이 각자 따로 처리하면 row 가 여러 개.
        // 모바일은 본인 worker 가 이 안에 있는지 체크해 자기 리스트에서만 빼고, 작업현황 탭은
        // 이 목록을 row 별로 펼쳐 직원별 카드로 보여준다.
        private List<WorkerCompletionInfo> workerCompletions;
        // 워처가 분배함에서 클릭한 슬롯 라벨 — 작업현황에서 "이 지시서가 어느 직원들에게 배정됐었는가" 표시용.
        private List<String> departmentSlots;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
        private LocalDateTime deletedAt;
    }

    @Getter
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class WorkerCompletionInfo {
        private String worker;
        private LocalDateTime completedAt;
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
        private Boolean isEvidence;
        private String uploadedDepartment;
        private LocalDateTime createdAt;
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
                        .isEvidence(Boolean.TRUE.equals(file.getIsEvidence()))
                        .uploadedDepartment(file.getUploadedDepartment())
                        .createdAt(file.getCreatedAt())
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
                .worksheetPdfUrl(order.getWorksheetPdfUrl())
                .worksheetOriginalPdfUrl(order.getWorksheetOriginalPdfUrl())
                .worksheetThumbnailUrl(order.getWorksheetThumbnailUrl())
                .evidenceLastUploadedAt(order.getEvidenceLastUploadedAt())
                .worksheetUpdatedAt(order.getWorksheetUpdatedAt())
                .worksheetChangeNote(order.getWorksheetChangeNote())
                .adminViewedAt(order.getAdminViewedAt())
                .workerCompletions(order.getWorkerCompletions().stream()
                        .map(wc -> WorkerCompletionInfo.builder()
                                .worker(wc.getWorker())
                                .completedAt(wc.getCompletedAt())
                                .build())
                        .toList())
                .departmentSlots(splitCsv(order.getDepartmentSlots()))
                .createdAt(order.getCreatedAt())
                .updatedAt(order.getUpdatedAt())
                .deletedAt(order.getDeletedAt())
                .build();
    }

    private static List<String> splitCsv(String csv) {
        if (csv == null || csv.isBlank()) return List.of();
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (String part : csv.split(",")) {
            String t = part.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }
}
