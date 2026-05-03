package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderRepository;
import com.example.backend.service.ClientService;
import com.example.backend.service.WorksheetThumbnailService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Slf4j
@RestController
@RequestMapping("/api/admin/orders")
@RequiredArgsConstructor
public class AdminOrderController {

    private final OrderRepository orderRepository;
    private final ClientService clientService;
    private final S3Client s3Client;
    private final WorksheetThumbnailService thumbnailService;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    // 관리자 대리 발주 — 메일/전화로 들어온 거래처 발주를 관리자가 직접 등록.
    // 거래처 로그인을 거치지 않고 clientId 만으로 동일한 발주 흐름을 태운다.
    @PostMapping("/proxy")
    public ResponseEntity<OrderDto.Response> proxyOrder(
            @RequestParam Long clientId,
            @RequestParam(required = false) String title,
            @RequestParam(required = false) String additionalItems,
            @RequestParam(required = false) String note,
            @RequestParam String dueDate,
            @RequestParam(required = false) String dueTime,
            @RequestParam String deliveryMethod,
            @RequestParam(required = false) String deliveryAddress,
            @RequestParam(required = false) List<MultipartFile> files
    ) {
        return ResponseEntity.ok(
                clientService.submitOrderByClientId(
                        clientId, title, additionalItems, note,
                        dueDate, dueTime, deliveryMethod, deliveryAddress, files
                )
        );
    }

    // 수동 작성 지시서용 — FlexSign 에 이미 그려놓은 지시서에 QR + 주문번호만 덧붙여
    // PDF24 로 웹에 등록하기 위한 빈 주문. 거래처만 받고 나머지(제목/납기/배송)는
    // 인쇄 매칭 다이얼로그에서 채운다.
    @PostMapping("/qr-only")
    public ResponseEntity<OrderDto.Response> createQrOnlyOrder(@RequestParam Long clientId) {
        return ResponseEntity.ok(clientService.createQrOnlyOrder(clientId));
    }

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

    // 관리자가 모달을 열면 "본 시각" 갱신 → 행 배지(신규 사진/지시서 변경) 클리어.
    // 멱등 — 여러 번 호출해도 동일.
    @PutMapping("/{id}/viewed")
    public ResponseEntity<OrderDto.Response> markViewed(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));
        order.setAdminViewedAt(LocalDateTime.now());
        return ResponseEntity.ok(OrderDto.toResponse(orderRepository.save(order)));
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

    /**
     * 일회성 백필 — worksheetPdfUrl 은 있는데 worksheetThumbnailUrl 이 비어있는 옛 주문들에 대해
     * R2 의 PDF 를 받아 썸네일을 생성/업로드/저장. 신규 PDF 업로드 흐름과 동일한 결과를 만든다.
     *
     * 한 번에 너무 많이 처리하면 HTTP 타임아웃 / R2 throttling 우려가 있어 limit (기본 50) 으로
     * 페이지 단위 처리. 호출 결과의 remaining 이 0 이 될 때까지 반복 호출하면 끝.
     * 각 주문은 best-effort — 실패하면 worksheetThumbnailUrl 을 NULL 로 두고 다음 호출에서 재시도.
     */
    @PostMapping("/backfill-worksheet-thumbnails")
    public ResponseEntity<?> backfillWorksheetThumbnails(
            @RequestParam(defaultValue = "50") int limit
    ) {
        if (limit < 1) limit = 1;
        if (limit > 200) limit = 200;

        long totalRemainingBefore = orderRepository
                .countByWorksheetPdfUrlIsNotNullAndWorksheetThumbnailUrlIsNull();
        List<Order> batch = orderRepository
                .findByWorksheetPdfUrlIsNotNullAndWorksheetThumbnailUrlIsNullOrderByCreatedAtDesc(
                        PageRequest.of(0, limit));

        int processed = 0;
        int succeeded = 0;
        int failed = 0;
        for (Order order : batch) {
            processed += 1;
            String pdfUrl = order.getWorksheetPdfUrl();
            String pdfKey = thumbnailService.extractKey(pdfUrl);
            if (pdfKey == null) {
                log.warn("백필 — R2 key 추출 실패 [{}], url={}", order.getOrderNumber(), pdfUrl);
                failed += 1;
                continue;
            }
            byte[] pdfBytes = thumbnailService.downloadObject(pdfKey);
            if (pdfBytes == null) {
                failed += 1;
                continue;
            }
            String thumbUrl = thumbnailService.renderAndUpload(order.getOrderNumber(), pdfBytes);
            if (thumbUrl == null) {
                failed += 1;
                continue;
            }
            order.setWorksheetThumbnailUrl(thumbUrl);
            orderRepository.save(order);
            succeeded += 1;
        }

        long remainingAfter = Math.max(0L, totalRemainingBefore - succeeded);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("totalRemainingBefore", totalRemainingBefore);
        body.put("processed", processed);
        body.put("succeeded", succeeded);
        body.put("failed", failed);
        body.put("remaining", remainingAfter);
        body.put("limit", limit);
        log.info("지시서 썸네일 백필 — 처리 {}, 성공 {}, 실패 {}, 남은 {}",
                processed, succeeded, failed, remainingAfter);
        return ResponseEntity.ok(body);
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
        // 지시서 PDF (worksheetPdfUrl) 도 함께 영구삭제. order_files 테이블엔 없는
        // Order 자체의 컬럼이라 위 루프에서 누락되는 R2 누수 지점이었음.
        String worksheetKey = extractKeyFromPublicUrl(order.getWorksheetPdfUrl());
        if (worksheetKey != null) {
            keysToDelete.add(worksheetKey);
        }
        String worksheetThumbKey = extractKeyFromPublicUrl(order.getWorksheetThumbnailUrl());
        if (worksheetThumbKey != null) {
            keysToDelete.add(worksheetThumbKey);
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
    public ResponseEntity<StreamingResponseBody> downloadWorksheetPackage(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        // ZIP 빌드 시작 전에 트랜잭션 안에서 메타/파일 컬렉션을 모두 확정한다.
        // StreamingResponseBody 람다는 핸들러 리턴 후 별도 스레드에서 실행 — LAZY 컬렉션 직접
        // 접근 시 LazyInitializationException 발생하므로, files 를 ArrayList 로 분리해 캡처.
        Map<String, Object> info = buildWorksheetInfo(order);
        byte[] jsonBytes;
        try {
            jsonBytes = new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsBytes(info);
        } catch (Exception e) {
            throw new RuntimeException("지시서 정보 직렬화 실패: " + e.getMessage());
        }
        String orderNumber = order.getOrderNumber();
        List<OrderFile> files = new ArrayList<>(order.getFiles());

        // R2 객체별로 InputStream 을 받아 ZipOutputStream 으로 transferTo — 8KB 청크 흐름.
        // 거래처 원본 파일 합이 수백 MB 가 돼도 메모리 사용은 청크 한 개분(수 KB) 만 점유.
        StreamingResponseBody body = output -> {
            try (ZipOutputStream zos = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
                zos.putNextEntry(new ZipEntry(orderNumber + ".json"));
                zos.write(jsonBytes);
                zos.closeEntry();

                for (OrderFile file : files) {
                    if (file.getStoredName() == null || file.getStoredName().isBlank()) continue;
                    String name = file.getOriginalName() != null ? file.getOriginalName() : file.getStoredName();
                    zos.putNextEntry(new ZipEntry(name));
                    try (InputStream in = s3Client.getObject(
                            GetObjectRequest.builder().bucket(bucket).key(file.getStoredName()).build())) {
                        in.transferTo(zos);
                    } catch (Exception ignored) {
                        // 한 파일 실패는 best-effort — 다음 파일 계속 진행. 이미 putNextEntry 한 상태라
                        // closeEntry 로 빈 엔트리 마무리.
                    }
                    zos.closeEntry();
                }
            }
        };

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        headers.set("Content-Disposition",
                "attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(orderNumber + "_지시서.zip", StandardCharsets.UTF_8).replace("+", "%20"));
        return ResponseEntity.ok().headers(headers).body(body);
    }

    // 자동지시서작성이 실패해 거래처 원본만 받아진 경우의 폴백.
    // 거래처 원본 AI 는 빼고 메타데이터만 ZIP 으로 내보낸다. 워처가 headerOnly 플래그를 보고
    // 빈 캔버스에 헤더(QR + 박스 + 좌측텍스트 + 노트박스)만 그린 작은 AI 를 만들어 FlexSign 에 띄움.
    // 사용자는 그 헤더를 복사해 거래처 원본 캔버스에 붙여 인쇄 → PDF24 → 매칭 으로 동일 흐름 복귀.
    @GetMapping("/{id}/worksheet-header-package")
    public ResponseEntity<StreamingResponseBody> downloadWorksheetHeaderPackage(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        Map<String, Object> info = buildWorksheetInfo(order);
        info.put("headerOnly", true);
        byte[] jsonBytes;
        try {
            jsonBytes = new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsBytes(info);
        } catch (Exception e) {
            throw new RuntimeException("헤더 정보 직렬화 실패: " + e.getMessage());
        }
        String orderNumber = order.getOrderNumber();

        StreamingResponseBody body = output -> {
            try (ZipOutputStream zos = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
                zos.putNextEntry(new ZipEntry(orderNumber + ".json"));
                zos.write(jsonBytes);
                zos.closeEntry();
            }
        };

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        headers.set("Content-Disposition",
                "attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(orderNumber + "_지시서_헤더만.zip", StandardCharsets.UTF_8).replace("+", "%20"));
        return ResponseEntity.ok().headers(headers).body(body);
    }

    private Map<String, Object> buildWorksheetInfo(Order order) {
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("orderNumber", order.getOrderNumber());
        ClientUser client = order.getClient();
        String companyName = client.getCompanyName();
        String networkFolderName = client.getNetworkFolderName();
        String contactName = client.getContactName();
        String effectiveNetworkFolderName = stripContactSuffix(
                isBlank(networkFolderName) ? companyName : networkFolderName
        );
        String effectiveContactName = isBlank(contactName)
                ? firstNonBlank(extractContactSuffix(companyName), extractContactSuffix(networkFolderName))
                : contactName.trim();

        info.put("companyName", companyName);
        // 워처가 거래처 폴더 매칭에 우선 사용. 빈 값이면 워처가 companyName 으로 폴백.
        // 담당자가 여러 명이어도 거래처 폴더는 회사 폴더 하나를 사용하고,
        // 워처가 주문 폴더명 끝에 담당자명을 붙여 구분한다.
        info.put("networkFolderName", effectiveNetworkFolderName);
        info.put("contactName", effectiveContactName);
        info.put("phone", client.getPhone());
        info.put("title", order.getTitle());
        info.put("requestType", order.getRequestType().name());
        info.put("dueDate", order.getDueDate() != null ? order.getDueDate().toString() : null);
        info.put("dueTime", order.getDueTime());
        info.put("deliveryMethod", order.getDeliveryMethod() != null ? deliveryLabel(order.getDeliveryMethod()) : null);
        info.put("deliveryAddress", order.getDeliveryAddress());
        info.put("additionalItems", order.getAdditionalItems());
        info.put("note", order.getNote());
        info.put("createdAt", order.getCreatedAt().toString());
        return info;
    }

    private boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private String firstNonBlank(String first, String second) {
        if (!isBlank(first)) return first.trim();
        if (!isBlank(second)) return second.trim();
        return "";
    }

    private String stripContactSuffix(String value) {
        String raw = value == null ? "" : value.trim();
        int open = raw.lastIndexOf('(');
        if (open <= 0 || !raw.endsWith(")")) {
            return raw;
        }
        String root = raw.substring(0, open).trim();
        String contact = raw.substring(open + 1, raw.length() - 1).trim();
        return root.isEmpty() || contact.isEmpty() ? raw : root;
    }

    private String extractContactSuffix(String value) {
        String raw = value == null ? "" : value.trim();
        int open = raw.lastIndexOf('(');
        if (open <= 0 || !raw.endsWith(")")) {
            return "";
        }
        String root = raw.substring(0, open).trim();
        String contact = raw.substring(open + 1, raw.length() - 1).trim();
        return root.isEmpty() ? "" : contact;
    }

    private String deliveryLabel(Order.DeliveryMethod method) {
        return switch (method) {
            case CARGO -> "화물 발송";
            case QUICK -> "퀵 발송";
            case DIRECT -> "직접 배송";
            case PICKUP -> "직접 수령";
            case LOCAL_CARGO -> "지방화물차 배송";
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
