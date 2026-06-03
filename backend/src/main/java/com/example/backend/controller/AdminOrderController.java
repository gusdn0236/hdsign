package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.AutoQuoteEstimate;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.AutoQuoteEstimateRepository;
import com.example.backend.repository.OrderRepository;
import com.example.backend.service.ClientService;
import com.example.backend.service.OrderArchiveService;
import com.example.backend.service.StorageUsageService;
import com.example.backend.service.WorksheetFlattenService;
import com.example.backend.service.WorksheetThumbnailService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;
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
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
// software.amazon.awssdk.core.sync.RequestBody 는 명시 임포트하지 않음 — Spring 의
// @RequestBody (org.springframework.web.bind.annotation.*) 와 클래스명 충돌해서
// 같은 파일 내 다른 핸들러의 @RequestBody 가 깨진다. 본문에서 FQN 으로 사용.

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Slf4j
@RestController
@RequestMapping("/api/admin/orders")
@RequiredArgsConstructor
public class AdminOrderController {

    private final OrderRepository orderRepository;
    private final AutoQuoteEstimateRepository estimateRepository;
    private final ClientService clientService;
    private final S3Client s3Client;
    private final WorksheetThumbnailService thumbnailService;
    private final WorksheetFlattenService flattenService;
    private final OrderArchiveService orderArchiveService;
    private final StorageUsageService storageUsageService;
    private final JdbcTemplate jdbcTemplate;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    // [임시] UTC → KST 일괄 마이그레이션 — Dockerfile TZ 설정 이전에 UTC 로 저장된 모든
    // datetime/timestamp 컬럼을 +9시간. 한 번만 호출하면 됨(두 번 호출되면 +18 됨).
    // information_schema 에서 동적으로 컬럼 목록을 받아 처리하므로 Order/WorkerCompletion 외에도
    // ClientUser, Notice 등 모든 entity 의 LocalDateTime 컬럼이 함께 보정된다.
    // 호출 후 다음 커밋에서 이 endpoint 는 제거 — 잘못된 두 번째 호출 위험 차단.
    @PostMapping("/migrate-utc-to-kst")
    public ResponseEntity<?> migrateUtcToKst() {
        // 현재 DB 의 datetime/timestamp 컬럼 모두 검색.
        List<Map<String, Object>> cols = jdbcTemplate.queryForList(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns " +
                "WHERE table_schema = DATABASE() " +
                "AND DATA_TYPE IN ('datetime', 'timestamp') " +
                "ORDER BY TABLE_NAME, COLUMN_NAME"
        );
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Map<String, Object> col : cols) {
            String table = (String) col.get("TABLE_NAME");
            String column = (String) col.get("COLUMN_NAME");
            if (table == null || column == null) continue;
            // 백틱으로 식별자 quote — 컬럼명이 SQL 예약어여도 안전.
            String sql = String.format(
                    "UPDATE `%s` SET `%s` = DATE_ADD(`%s`, INTERVAL 9 HOUR) WHERE `%s` IS NOT NULL",
                    table, column, column, column);
            int n = jdbcTemplate.update(sql);
            counts.put(table + "." + column, n);
            log.info("UTC→KST 마이그레이션 [{}].{} +9h: {} rows", table, column, n);
        }
        int total = counts.values().stream().mapToInt(Integer::intValue).sum();
        result.put("total_rows_updated", total);
        result.put("counts", counts);
        result.put("note", "한 번만 실행. 다음 커밋에서 endpoint 제거 예정.");
        return ResponseEntity.ok(result);
    }

    // 관리자 대리 발주 — 메일/전화로 들어온 거래처 발주를 관리자가 직접 등록.
    // 거래처 로그인을 거치지 않고 clientId 만으로 동일한 발주 흐름을 태운다.
    // 납기/배송은 이 단계에서 선택 — 일러스트를 열어보지 않고 빠르게 등록한 뒤
    // 인쇄 매칭 다이얼로그에서 통화 후 확정해 채운다.
    @PostMapping("/proxy")
    public ResponseEntity<OrderDto.Response> proxyOrder(
            @RequestParam Long clientId,
            @RequestParam(required = false) String title,
            @RequestParam(required = false) String additionalItems,
            @RequestParam(required = false) String note,
            @RequestParam(required = false) String dueDate,
            @RequestParam(required = false) String dueTime,
            @RequestParam(required = false) String deliveryMethod,
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
    // PDF24 로 웹에 등록하기 위한 빈 주문. 거래처는 필수, 제목/납기/배송은 워처
    // [신규 작성] 폼에서 같이 받아 채워둔다(미입력은 null 유지).
    @PostMapping("/qr-only")
    public ResponseEntity<OrderDto.Response> createQrOnlyOrder(
            @RequestParam Long clientId,
            @RequestParam(required = false) String title,
            @RequestParam(required = false) String dueDate,
            @RequestParam(required = false) String deliveryMethod,
            @RequestParam(required = false) String deliveryAddress
    ) {
        return ResponseEntity.ok(clientService.createQrOnlyOrder(
                clientId, title, dueDate, deliveryMethod, deliveryAddress));
    }

    // 전체 작업 목록 조회 (휴지통 제외, 최신순)
    @GetMapping
    public ResponseEntity<List<OrderDto.Response>> getAllOrders() {
        return ResponseEntity.ok(toResponsesWithEstimates(
                orderRepository.findByDeletedAtIsNullOrderByCreatedAtDesc()));
    }

    // 작업완료(휴지통) 목록 — 30일 후 자동 완전삭제 대상.
    @GetMapping("/trash")
    public ResponseEntity<List<OrderDto.Response>> getTrash() {
        return ResponseEntity.ok(toResponsesWithEstimates(
                orderRepository.findByDeletedAtIsNotNullOrderByDeletedAtDesc()));
    }

    // 주문 목록 → 응답 변환 + 자동견적 명세서(estimate) 배지 플래그 enrich.
    // 목록의 order_id 들로 estimate 를 한 번에 배치 조회해 N+1 을 피한다.
    private List<OrderDto.Response> toResponsesWithEstimates(List<Order> orders) {
        if (orders.isEmpty()) return List.of();
        List<Long> ids = orders.stream().map(Order::getId).toList();
        Map<Long, AutoQuoteEstimate> byOrderId = new HashMap<>();
        for (AutoQuoteEstimate est : estimateRepository.findByOrderIdIn(ids)) {
            byOrderId.put(est.getOrderId(), est);
        }
        return orders.stream()
                .map(o -> OrderDto.toResponse(o, byOrderId.get(o.getId())))
                .toList();
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

    // ===== 자동견적 명세서(estimate) — slice-12 (ADDITIVE) =====
    // 주문 상세모달 "명세서작성" → /admin/autoquote 에서 작성한 명세서를 주문당 1건 저장/조회.
    // 작업중/작업완료 공용. 명세서 본문(grid 등)은 JSON 그대로 보관한다.

    // 명세서 저장(upsert) — 주문당 1건. body = 명세서 JSON(grid + 메타) 전체.
    @PutMapping("/{id}/estimate")
    public ResponseEntity<?> putEstimate(@PathVariable Long id, @RequestBody(required = false) JsonNode body) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));
        if (body == null || body.isNull()) {
            return ResponseEntity.badRequest().body(Map.of("message", "명세서 본문이 비어 있습니다."));
        }
        AutoQuoteEstimate est = estimateRepository.findByOrderId(order.getId())
                .orElseGet(() -> AutoQuoteEstimate.builder().orderId(order.getId()).build());
        est.setGridJson(body.toString());
        est.setSavedAt(LocalDateTime.now());
        return ResponseEntity.ok(estimateResponse(estimateRepository.save(est)));
    }

    // 명세서 조회 — 없으면 404(프론트는 "신규 작성"으로 처리).
    @GetMapping("/{id}/estimate")
    public ResponseEntity<?> getEstimate(@PathVariable Long id) {
        AutoQuoteEstimate est = estimateRepository.findByOrderId(id).orElse(null);
        if (est == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "estimate_not_found"));
        }
        return ResponseEntity.ok(estimateResponse(est));
    }

    // 이지폼 업로드 완료 표시(slice-14 매크로가 호출) → "이지폼" 배지. 명세서 선행 필수.
    @PostMapping("/{id}/estimate/easyform-uploaded")
    public ResponseEntity<?> markEasyformUploaded(@PathVariable Long id) {
        AutoQuoteEstimate est = estimateRepository.findByOrderId(id).orElse(null);
        if (est == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "estimate_not_found",
                            "message", "먼저 명세서를 저장해야 합니다."));
        }
        est.setEasyformUploadedAt(LocalDateTime.now());
        return ResponseEntity.ok(estimateResponse(estimateRepository.save(est)));
    }

    // estimate 응답 — gridJson 을 다시 JSON 으로 파싱해 estimate 필드로 돌려준다.
    private Map<String, Object> estimateResponse(AutoQuoteEstimate est) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("orderId", est.getOrderId());
        body.put("hasEstimate", true);
        body.put("savedAt", est.getSavedAt() != null ? est.getSavedAt().toString() : null);
        body.put("easyformUploadedAt",
                est.getEasyformUploadedAt() != null ? est.getEasyformUploadedAt().toString() : null);
        try {
            body.put("estimate", new ObjectMapper().readTree(est.getGridJson()));
        } catch (Exception e) {
            body.put("estimate", null);
        }
        return body;
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

    // 납기 갱신 — 일괄 완료 검토에서 "지연으로 떠있지만 실제 납기는 미래"인 건의 dueDate 만 교체.
    // 본문: { "dueDate": "yyyy-MM-dd" }. 같은 값으로 와도 변경 없음(배지 트리거 X).
    @PutMapping("/{id}/due-date")
    public ResponseEntity<?> updateDueDate(
            @PathVariable Long id,
            @RequestBody Map<String, Object> body
    ) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));
        if (body == null) body = Map.of();
        String dueRaw = body.get("dueDate") instanceof String s ? s : null;
        if (dueRaw == null || dueRaw.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "dueDate 가 필요합니다."));
        }
        java.time.LocalDate parsed;
        try {
            parsed = java.time.LocalDate.parse(dueRaw.trim());
        } catch (java.time.format.DateTimeParseException e) {
            return ResponseEntity.badRequest().body(Map.of("message", "dueDate 포맷은 yyyy-MM-dd 입니다."));
        }
        if (!parsed.equals(order.getDueDate())) {
            order.setDueDate(parsed);
            order.setWorksheetUpdatedAt(LocalDateTime.now());
        }
        return ResponseEntity.ok(OrderDto.toResponse(orderRepository.save(order)));
    }

    // 휴지통으로 이동 (soft delete) — 어떤 상태에서도 가능. COMPLETED 가 아니면
    // 동시에 COMPLETED 로 바꿔 의미를 통일한다(휴지통 = 완료 아카이브).
    @DeleteMapping("/{id}")
    public ResponseEntity<?> moveToTrash(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getDeletedAt() != null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "이미 작업완료로 이동된 작업입니다."));
        }

        if (order.getStatus() != Order.OrderStatus.COMPLETED) {
            order.setStatus(Order.OrderStatus.COMPLETED);
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
                    .body(Map.of("message", "작업완료 상태가 아닌 작업입니다."));
        }

        order.setDeletedAt(null);
        Order saved = orderRepository.save(order);
        return ResponseEntity.ok(OrderDto.toResponse(saved));
    }

    // 작업완료에서 즉시 완전 삭제 — R2 의 도안·미리보기·지시서 PDF·order_files 행 + Order 행까지
    // 모두 하드 삭제. 30일 자동 삭제 전에 관리자가 수동으로 지울 수도 있게 둠.
    @DeleteMapping("/{id}/permanent")
    public ResponseEntity<?> deletePermanently(@PathVariable Long id) {
        Order order = orderRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업을 찾을 수 없습니다."));

        if (order.getDeletedAt() == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "작업완료 상태의 작업만 영구 삭제할 수 있습니다."));
        }

        orderArchiveService.hardDeleteOrder(order);
        storageUsageService.invalidateCache();
        return ResponseEntity.noContent().build();
    }

    // 작업완료 전체 일괄 영구삭제 — 사고 방지를 위해 본문에 confirmation="전부삭제" 가 필수.
    // 30일 자동 삭제를 기다리지 않고 관리자가 직접 R2 사용량을 정리할 때 사용. 한 건씩 best-effort
    // 로 hardDeleteOrder 를 돌고, 실패 건수는 응답에 포함해 프론트에 표시한다.
    @DeleteMapping("/trash/purge-all")
    public ResponseEntity<?> purgeAllTrash(@RequestBody(required = false) Map<String, Object> body) {
        String confirmation = body == null ? null : String.valueOf(body.getOrDefault("confirmation", ""));
        if (!"전부삭제".equals(confirmation)) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("message", "confirmation 값이 일치하지 않습니다. \"전부삭제\" 를 정확히 입력해 주세요."));
        }

        List<Order> targets = orderRepository.findByDeletedAtIsNotNullOrderByDeletedAtDesc();
        int deleted = 0;
        int failed = 0;
        for (Order order : targets) {
            try {
                orderArchiveService.hardDeleteOrder(order);
                deleted += 1;
            } catch (Exception e) {
                log.warn("[PurgeAllTrash] 주문 {} 삭제 실패: {}", order.getOrderNumber(), e.getMessage());
                failed += 1;
            }
        }
        storageUsageService.invalidateCache();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("deleted", deleted);
        result.put("failed", failed);
        return ResponseEntity.ok(result);
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

    /**
     * 기존 R2 의 작업지시서 PDF 를 평탄화(페이지당 단일 JPEG)된 PDF 로 재저장.
     * 갤럭시 등 안드로이드 Chrome 의 pdf.js 가 다중 비트맵 타일 PDF 에서 멈추는 문제를
     * 기존 데이터에도 적용하기 위함. 신규 업로드는 PublicEvidenceController 가 자동 처리하므로
     * 이 엔드포인트는 한 번만 돌려 백로그를 정리하는 용도.
     *
     * <p>"이미 평탄화됨" 마커 컬럼은 두지 않음 — 재처리해도 결과는 시각적으로 동일하고
     * 비용도 페이지당 1~2초로 미미. 페이지 파라미터(page=0,1,...) 로 walk 하거나 limit 만
     * 키워 한 번에 끝내면 됨. worksheetUpdatedAt 는 손대지 않아 모바일/관리자에 "변경" 배지가
     * 잘못 트리거되지 않는다(동일 내용 재포맷이라 사용자 입장에선 변경 아님).
     */
    @PostMapping("/backfill-worksheet-flatten")
    public ResponseEntity<?> backfillWorksheetFlatten(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int limit
    ) {
        if (limit < 1) limit = 1;
        // 평탄화는 썸네일보다 무거움(페이지당 PDFBox 렌더 + JPEG 인코딩 + 새 PDF 직렬화).
        // Railway 60s HTTP 타임아웃 안에 들어오도록 한도 조심스럽게 잡음.
        if (limit > 50) limit = 50;
        if (page < 0) page = 0;

        long total = orderRepository.countByWorksheetPdfUrlIsNotNullAndDeletedAtIsNull();
        List<Order> batch = orderRepository
                .findByWorksheetPdfUrlIsNotNullAndDeletedAtIsNullOrderByCreatedAtDesc(
                        PageRequest.of(page, limit));

        String normalizedPublicUrl = publicUrl == null || publicUrl.isBlank()
                ? "" : (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");

        int processed = 0, succeeded = 0, failed = 0;
        for (Order order : batch) {
            processed += 1;
            String oldUrl = order.getWorksheetPdfUrl();
            String oldKey = thumbnailService.extractKey(oldUrl);
            if (oldKey == null) {
                log.warn("평탄화 백필 — R2 key 추출 실패 [{}], url={}", order.getOrderNumber(), oldUrl);
                failed += 1;
                continue;
            }
            byte[] pdfBytes = thumbnailService.downloadObject(oldKey);
            if (pdfBytes == null) {
                failed += 1;
                continue;
            }
            byte[] flattened = flattenService.flatten(pdfBytes);
            if (flattened == null) {
                failed += 1;
                continue;
            }

            // 새 키로 업로드 → DB url 교체 → 옛 키 best-effort 삭제. worksheetUpdatedAt 은 손대지 않음.
            boolean preserveOldAsOriginal = order.getWorksheetOriginalPdfUrl() == null
                    || order.getWorksheetOriginalPdfUrl().isBlank();
            String newKey = "orders/" + order.getOrderNumber() + "/worksheet/flattened-" + UUID.randomUUID() + ".pdf";
            try {
                s3Client.putObject(
                        PutObjectRequest.builder()
                                .bucket(bucket)
                                .key(newKey)
                                .contentType("application/pdf")
                                .build(),
                        software.amazon.awssdk.core.sync.RequestBody.fromBytes(flattened)
                );
            } catch (Exception e) {
                log.warn("평탄화 PDF 업로드 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
                failed += 1;
                continue;
            }
            if (preserveOldAsOriginal) {
                order.setWorksheetOriginalPdfUrl(oldUrl);
            }
            order.setWorksheetPdfUrl(normalizedPublicUrl + newKey);
            orderRepository.save(order);
            if (!preserveOldAsOriginal) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket).key(oldKey).build());
            } catch (Exception e) {
                log.warn("이전 지시서 PDF 삭제 실패 [{}/{}]: {}",
                        order.getOrderNumber(), oldKey, e.getMessage());
            }
            }
            log.info("지시서 PDF 평탄화 [{}]: {} → {} bytes",
                    order.getOrderNumber(), pdfBytes.length, flattened.length);
            succeeded += 1;
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("total", total);
        body.put("page", page);
        body.put("processed", processed);
        body.put("succeeded", succeeded);
        body.put("failed", failed);
        body.put("limit", limit);
        log.info("지시서 PDF 평탄화 백필 — page={} 처리 {}, 성공 {}, 실패 {}",
                page, processed, succeeded, failed);
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
        String worksheetOriginalKey = extractKeyFromPublicUrl(order.getWorksheetOriginalPdfUrl());
        if (worksheetOriginalKey != null && !worksheetOriginalKey.equals(worksheetKey)) {
            keysToDelete.add(worksheetOriginalKey);
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
            case TBD -> "배송 추후결정";
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
