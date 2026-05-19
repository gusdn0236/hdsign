package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderFileRepository;
import com.example.backend.repository.OrderRepository;
import com.example.backend.service.GoogleDriveBackupService;
import com.example.backend.service.WorksheetFlattenService;
import com.example.backend.service.WorksheetThumbnailService;
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
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
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
    private final WorksheetThumbnailService thumbnailService;
    private final WorksheetFlattenService flattenService;
    private final GoogleDriveBackupService driveBackupService;

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

    /**
     * 모바일 지시서 뷰어용 — 해당 주문에 업로드된 증거사진 목록.
     * 인증 없음(업로드와 동일한 보안 수준 — QR 로 주문번호를 안 사람만 접근).
     * 각 항목의 imageUrl 은 같은 출처의 프록시 URL — 프론트에서 fetch().blob() 로
     * Web Share API 의 File 객체를 만들 수 있게 한다(R2 공개 URL 은 CORS 미개방).
     */
    @GetMapping("/{orderNumber}/evidence")
    public ResponseEntity<?> listEvidence(@PathVariable String orderNumber) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        List<Map<String, Object>> items = orderFileRepository.findByOrder(order).stream()
                .filter(f -> Boolean.TRUE.equals(f.getIsEvidence()))
                .sorted(Comparator.comparing(
                        OrderFile::getCreatedAt,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .map(f -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", f.getId());
                    m.put("originalName", f.getOriginalName());
                    m.put("contentType", f.getContentType());
                    m.put("fileSize", f.getFileSize());
                    m.put("uploadedDepartment", f.getUploadedDepartment());
                    m.put("createdAt", f.getCreatedAt() != null ? f.getCreatedAt().toString() : null);
                    String base = "/api/public/orders/" + orderNumber
                            + "/evidence/" + f.getId() + "/image";
                    m.put("imageUrl", base);
                    // 사진보기 그리드용 썸네일. 업로드 시 미리 생성해 둔 R2 키가 있으면
                    // 그 public URL 을 직접 — 서버 거치지 않고 R2/CDN 에서 바로 떨어져 가장 빠름.
                    // 없으면(레거시) 프록시 ?thumb=1 로 폴백(첫 호출만 느림).
                    String pre = f.getPreviewUrl();
                    m.put("thumbnailUrl", (pre != null && !pre.isBlank()) ? pre : (base + "?thumb=1"));
                    return m;
                })
                .toList();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("orderNumber", orderNumber);
        body.put("count", items.size());
        body.put("items", items);
        return ResponseEntity.ok(body);
    }

    /**
     * 증거사진 이미지 프록시 — R2 의 사진을 같은 출처(백엔드)로 응답.
     * 프론트가 fetch().blob() 로 받아 Web Share API 의 File 로 만들기 위함(R2 CORS 우회).
     * fileId 가 실제로 해당 orderNumber 에 속하는지 확인해 다른 주문 사진 노출 방지.
     */
    @GetMapping("/{orderNumber}/evidence/{fileId}/image")
    public ResponseEntity<?> proxyEvidenceImage(
            @PathVariable String orderNumber,
            @PathVariable Long fileId,
            // thumb=1(true) 일 때 ~360px 짜리 가벼운 JPEG 으로 다운스케일.
            // 사진보기 그리드용 — 화질보다 빠른 로딩 우선(원본은 클릭 시 라이트박스에서).
            @RequestParam(value = "thumb", required = false) Boolean thumb,
            @RequestHeader(value = "If-None-Match", required = false) String ifNoneMatch
    ) {
        OrderFile file = orderFileRepository.findById(fileId).orElse(null);
        if (file == null
                || !Boolean.TRUE.equals(file.getIsEvidence())
                || file.getOrder() == null
                || !orderNumber.equals(file.getOrder().getOrderNumber())) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String key = file.getStoredName();
        if (key == null || key.isBlank()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        boolean wantThumb = Boolean.TRUE.equals(thumb);
        // 썸네일 / 원본은 캐시 키도 ETag 도 분리 — 둘 다 동일한 max-age 로 길게 캐시.
        String etag = "\"" + Integer.toHexString(key.hashCode())
                + (wantThumb ? "-t" : "") + "\"";
        if (etag.equals(ifNoneMatch)) {
            HttpHeaders headers = new HttpHeaders();
            headers.setCacheControl("public, max-age=86400");
            headers.setETag(etag);
            return new ResponseEntity<>(headers, HttpStatus.NOT_MODIFIED);
        }
        try {
            if (wantThumb) {
                byte[] thumbBytes = renderEvidenceThumbnail(key);
                if (thumbBytes != null) {
                    HttpHeaders headers = new HttpHeaders();
                    headers.setContentType(MediaType.IMAGE_JPEG);
                    headers.setContentLength(thumbBytes.length);
                    headers.setCacheControl("public, max-age=86400");
                    headers.setETag(etag);
                    headers.setContentDispositionFormData("inline", "thumb.jpg");
                    return new ResponseEntity<>(thumbBytes, headers, HttpStatus.OK);
                }
                // 썸네일 생성 실패 → 원본으로 폴백(빈 화면보다는 느려도 보이는 게 낫다).
            }
            ResponseInputStream<GetObjectResponse> stream = s3Client.getObject(
                    GetObjectRequest.builder().bucket(bucket).key(key).build()
            );
            HttpHeaders headers = new HttpHeaders();
            String contentType = file.getContentType();
            headers.setContentType(contentType != null && !contentType.isBlank()
                    ? MediaType.parseMediaType(contentType)
                    : MediaType.IMAGE_JPEG);
            headers.setContentLength(stream.response().contentLength());
            // R2 키가 바뀌지 않는 한 같은 파일이므로 길게 캐시해도 안전.
            headers.setCacheControl("public, max-age=86400");
            headers.setETag(etag);
            headers.setContentDispositionFormData("inline",
                    file.getOriginalName() != null ? file.getOriginalName() : "photo.jpg");
            return new ResponseEntity<>(new InputStreamResource(stream), headers, HttpStatus.OK);
        } catch (Exception e) {
            log.warn("증거사진 프록시 실패 [{}/{}]: {}", orderNumber, fileId, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /**
     * R2 의 원본 이미지를 받아 한 변 360px 짜리 JPEG 으로 다운스케일(읽기측 폴백).
     * 신규 업로드는 업로드 시점에 미리 생성해 둔다(uploadEvidence). 이 메서드는 그것이
     * 없는 레거시 사진에서만 호출.
     */
    private byte[] renderEvidenceThumbnail(String key) {
        try (ResponseInputStream<GetObjectResponse> stream = s3Client.getObject(
                GetObjectRequest.builder().bucket(bucket).key(key).build()
        )) {
            byte[] src = stream.readAllBytes();
            return renderThumbnailBytes(src);
        } catch (Exception e) {
            log.warn("증거사진 썸네일 렌더 실패 [{}]: {}", key, e.getMessage());
            return null;
        }
    }

    /**
     * 메모리상의 이미지 바이트 → 한 변 320px JPEG q=0.7. 업로드 시점에서 호출돼
     * R2 에 별도 키로 영구 저장된다 — 이후 그리드 표시는 R2 직접 스트리밍.
     * "적당히" 정책 — 사진 한 장 25-45KB. 미리 생성하므로 사이즈가 로딩 속도에 큰
     * 영향 없어 화질을 적당히 유지.
     * 실패 시 null.
     */
    private byte[] renderThumbnailBytes(byte[] imageBytes) {
        try {
            BufferedImage source = ImageIO.read(new java.io.ByteArrayInputStream(imageBytes));
            if (source == null) return null;
            final int maxSide = 320;
            int srcW = source.getWidth();
            int srcH = source.getHeight();
            int longest = Math.max(srcW, srcH);
            double scale = longest > maxSide ? (double) maxSide / longest : 1.0;
            int dstW = Math.max(1, (int) Math.round(srcW * scale));
            int dstH = Math.max(1, (int) Math.round(srcH * scale));
            BufferedImage dst = new BufferedImage(dstW, dstH, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = dst.createGraphics();
            try {
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                        RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.setRenderingHint(RenderingHints.KEY_RENDERING,
                        RenderingHints.VALUE_RENDER_QUALITY);
                g.drawImage(source, 0, 0, dstW, dstH, null);
            } finally {
                g.dispose();
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream(32 * 1024);
            ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            try (MemoryCacheImageOutputStream out = new MemoryCacheImageOutputStream(baos)) {
                writer.setOutput(out);
                ImageWriteParam param = writer.getDefaultWriteParam();
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(0.7f);
                writer.write(null, new IIOImage(dst, null, null), param);
            } finally {
                writer.dispose();
            }
            return baos.toByteArray();
        } catch (Exception e) {
            log.warn("증거사진 썸네일 인메모리 렌더 실패: {}", e.getMessage());
            return null;
        }
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

        // 드라이브 백업 @Async 가 별도 스레드에서 돌면서 lazy fetch 하면 "no session" 에러.
        // 트랜잭션/세션이 살아있는 지금 미리 추출해 String 으로 넘긴다.
        String companyName = order.getClient() != null ? order.getClient().getCompanyName() : null;
        String orderNumberForBackup = order.getOrderNumber();

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

            // 바이트로 한 번 읽어 R2 + 드라이브 백업 양쪽에 재사용. 사진은 보통 수 MB 라 메모리 비용 미미.
            byte[] bytes;
            try {
                bytes = file.getBytes();
            } catch (Exception e) {
                log.warn("증거 사진 읽기 실패 [{}/{}]: {}", order.getOrderNumber(), originalName, e.getMessage());
                continue;
            }

            try {
                s3Client.putObject(
                        PutObjectRequest.builder()
                                .bucket(bucket)
                                .key(key)
                                .contentType(file.getContentType() != null ? file.getContentType() : "image/jpeg")
                                .build(),
                        RequestBody.fromBytes(bytes)
                );
            } catch (Exception e) {
                log.warn("증거 사진 업로드 실패 [{}/{}]: {}", order.getOrderNumber(), originalName, e.getMessage());
                continue;
            }

            // 사진보기 그리드용 360px 썸네일을 업로드 시점에 한 번만 만들어 R2 에 별도 키로 보관.
            // 이후 그리드 표시는 R2 직접 스트리밍 — 서버 CPU 0ms, 라이트박스만큼 빠름.
            // 실패해도 흐름은 그대로 진행(읽기 측 프록시 ?thumb=1 폴백이 살아있음).
            String thumbPublicUrl = null;
            byte[] thumbBytes = renderThumbnailBytes(bytes);
            if (thumbBytes != null) {
                String thumbKey = "orders/" + order.getOrderNumber()
                        + "/evidence-thumbs/" + UUID.randomUUID() + ".jpg";
                try {
                    s3Client.putObject(
                            PutObjectRequest.builder()
                                    .bucket(bucket)
                                    .key(thumbKey)
                                    .contentType("image/jpeg")
                                    .build(),
                            RequestBody.fromBytes(thumbBytes)
                    );
                    thumbPublicUrl = normalizedPublicUrl + thumbKey;
                } catch (Exception e) {
                    log.warn("증거사진 썸네일 업로드 실패 [{}]: {}", thumbKey, e.getMessage());
                }
            }

            // R2 성공한 사진만 드라이브에도 백업. 비동기 — 응답 지연 0, 실패해도 흐름 영향 없음.
            driveBackupService.uploadEvidenceAsync(
                    orderNumberForBackup, companyName, originalName, file.getContentType(), bytes);

            OrderFile saved = orderFileRepository.save(OrderFile.builder()
                    .order(order)
                    .originalName(originalName)
                    .storedName(key)
                    .fileUrl(normalizedPublicUrl + key)
                    // previewUrl 컬럼을 증거사진 썸네일 R2 public URL 보관에 재사용.
                    // (기존 AI/PDF 변환 썸네일 용도와 충돌 없음 — isEvidence=true 행에서만 이 의미).
                    .previewUrl(thumbPublicUrl)
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
        Object slotsObj = body.get("departmentSlots");
        boolean hasDue = dueRaw != null && !dueRaw.isBlank();
        boolean hasDelivery = deliveryRaw != null && !deliveryRaw.isBlank();
        // tagsObj/slotsObj 가 List 면 명시적 갱신 의도(빈 배열도 "비우기" 의도). 키 자체가 없으면 갱신 안 함.
        boolean hasTags = tagsObj instanceof List<?>;
        boolean hasSlots = slotsObj instanceof List<?>;
        if (!hasDue && !hasDelivery && !hasTags && !hasSlots) {
            return ResponseEntity.badRequest().body(Map.of("message", "dueDate / deliveryMethod / departmentTags / departmentSlots 중 하나는 있어야 합니다."));
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

        // 분배함 슬롯 라벨 갱신 — 워처 다이얼로그에서 "이전 클릭 위치 그대로" 복원할 때 사용.
        // departmentTags 와 별도 — 부서가 같아도 슬롯이 다른 케이스를 구분하기 위함.
        if (hasSlots) {
            String csv = ((List<?>) slotsObj).stream()
                    .filter(java.util.Objects::nonNull)
                    .map(Object::toString)
                    .map(String::trim)
                    .filter(t -> !t.isEmpty())
                    .distinct()
                    .collect(java.util.stream.Collectors.joining(","));
            String oldCsv = order.getDepartmentSlots() == null ? "" : order.getDepartmentSlots();
            if (!csv.equals(oldCsv)) {
                order.setDepartmentSlots(csv.isEmpty() ? null : csv);
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
        resp.put("departmentSlots", splitTags(order.getDepartmentSlots()));
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
            // 워처 인쇄 다이얼로그에서 사용자가 "지시서 내용 변경" 분기로 진입했을 때 true
            // (= 텍스트 박스에 새 메모를 입력해 의미 있는 변경이 발생). 단순 재인쇄는 false.
            @RequestParam(value = "contentChanged", required = false) Boolean contentChanged,
            // 작업자가 입력한 변경 메모. 모바일 뷰어에서 PDF 한 번 탭하면 노출.
            // contentChanged=true 일 때만 새 값으로 갱신. 그 외엔 preserveChangeNote 에 따라 분기.
            @RequestParam(value = "changeNote", required = false) String changeNote,
            // 단순 재인쇄(작업자가 텍스트 박스에 미리 채워진 이전 메모를 그대로 둔 채 confirm).
            // true 면 DB 의 기존 worksheetChangeNote 를 건드리지 않는다(다음 다이얼로그 호출 시
            // 동일 메모가 또 prefill 되도록 영속). 미전송/false 면 기존 동작(메모 비우기) 유지 —
            // 구버전 워처 호환.
            @RequestParam(value = "preserveChangeNote", required = false) Boolean preserveChangeNote
    ) {
        Order order = orderRepository.findByOrderNumber(orderNumber).orElse(null);
        if (order == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "해당 작업지시서를 찾을 수 없습니다."));
        }
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "PDF 파일이 비어 있습니다."));
        }

        // 새 PDF 업로드 전에 이전 PDF/썸네일 키를 미리 잡아둔다 — 업로드/저장 성공 후 best-effort 로 삭제.
        // 실패해도 서비스 흐름엔 영향 없고 다음 영구삭제 시 정리되도록 keysToDelete 가 누적되지 않게
        // 매번 즉시 시도. 새 업로드가 실패하면 옛 PDF 가 그대로 남아 fallback 으로 사용 가능.
        String oldWorksheetKey = extractKeyFromPublicUrl(order.getWorksheetPdfUrl());
        String oldOriginalWorksheetKey = extractKeyFromPublicUrl(order.getWorksheetOriginalPdfUrl());
        String oldThumbnailKey = extractKeyFromPublicUrl(order.getWorksheetThumbnailUrl());

        // PDF 바이트를 한 번 메모리에 읽어 R2 업로드 + PDFBox 썸네일 렌더 양쪽에 재사용.
        // 지시서 PDF 는 보통 수백 KB ~ 수 MB 라 메모리 보관 비용 미미.
        byte[] originalPdfBytes;
        try {
            originalPdfBytes = file.getBytes();
        } catch (Exception e) {
            log.warn("지시서 PDF 읽기 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("message", "PDF 읽기에 실패했습니다."));
        }

        // 평탄화 — 일러스트 출력본의 다중 비트맵 타일 구조가 안드로이드 Chrome(갤럭시) 에서
        // pdf.js 를 멈추는 문제 우회. 페이지당 단일 JPEG 으로 재렌더된 PDF 로 대체한다.
        // 실패 시 원본 바이트로 폴백 — 업로드 자체는 절대 막지 않음.
        byte[] flattened = flattenService.flatten(originalPdfBytes);
        byte[] androidPdfBytes = flattened != null ? flattened : originalPdfBytes;
        if (flattened != null) {
            log.info("지시서 PDF 평탄화 [{}]: {} → {} bytes",
                    order.getOrderNumber(), originalPdfBytes.length, flattened.length);
        }

        String normalizedPublicUrl = publicUrl == null || publicUrl.isBlank()
                ? ""
                : (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");
        String originalKey = "orders/" + order.getOrderNumber() + "/worksheet/original-" + UUID.randomUUID() + ".pdf";
        String androidKey = flattened != null
                ? "orders/" + order.getOrderNumber() + "/worksheet/flattened-" + UUID.randomUUID() + ".pdf"
                : originalKey;
        try {
            s3Client.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(originalKey)
                            .contentType("application/pdf")
                            .build(),
                    RequestBody.fromBytes(originalPdfBytes)
            );
            if (flattened != null) {
                s3Client.putObject(
                        PutObjectRequest.builder()
                                .bucket(bucket)
                                .key(androidKey)
                                .contentType("application/pdf")
                                .build(),
                        RequestBody.fromBytes(androidPdfBytes)
                );
            }
        } catch (Exception e) {
            log.warn("지시서 PDF 업로드 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("message", "PDF 업로드에 실패했습니다."));
        }

        String originalUrl = normalizedPublicUrl + originalKey;
        String androidUrl = normalizedPublicUrl + androidKey;

        // 썸네일은 best-effort — 실패해도 PDF 업로드는 이미 성공했으므로 흐름 진행.
        // 프론트는 thumbnailUrl 없으면 PDF 직접 렌더로 폴백.
        String thumbnailUrl = thumbnailService.renderAndUpload(order.getOrderNumber(), androidPdfBytes);

        // 첫 부착(이전 URL 이 없었음) 또는 사용자가 새 메모를 입력했을 때만 "변경" 배지 트리거.
        // 단순 재인쇄(동일 내용)와 메모 보존(preserveChangeNote) 은 배지 안 띄움.
        // 납기/배송 실제 변경은 /due-date 에서 별도로 잡는다.
        boolean firstAttachment = order.getWorksheetPdfUrl() == null || order.getWorksheetPdfUrl().isBlank();
        boolean userMarkedChanged = Boolean.TRUE.equals(contentChanged);
        boolean preserveNote = Boolean.TRUE.equals(preserveChangeNote);
        order.setWorksheetPdfUrl(androidUrl);
        order.setWorksheetOriginalPdfUrl(originalUrl);
        // 썸네일 렌더 실패 시(thumbnailUrl == null) 기존 값을 덮어써 stale 썸네일이 남지 않도록 함.
        // 다음 업로드 때 다시 시도되며, 그 사이엔 프론트가 PDF 폴백으로 그린다.
        order.setWorksheetThumbnailUrl(thumbnailUrl);
        // 현장 뷰어 [FS에서 열기] 가 거래처 네트워크 폴더에서 .fs 파일을 stem 매칭으로
        // 찾을 수 있게 원본 PDF 파일명을 보존. 워처는 multipart Content-Disposition 의
        // filename 에 .ai stem 을 그대로 실어 보내므로 별도 form 필드 없이도 식별 가능.
        // 일부 클라이언트가 경로를 포함해 보낼 수 있으니 basename 만 취한다.
        String uploadedName = file.getOriginalFilename();
        if (uploadedName != null && !uploadedName.isBlank()) {
            int slash = Math.max(uploadedName.lastIndexOf('/'), uploadedName.lastIndexOf('\\'));
            String basename = slash >= 0 ? uploadedName.substring(slash + 1) : uploadedName;
            if (basename.length() > 255) basename = basename.substring(basename.length() - 255);
            order.setOriginalPdfFilename(basename);
        }
        if (firstAttachment || userMarkedChanged) {
            order.setWorksheetUpdatedAt(LocalDateTime.now());
        }
        // changeNote 처리 분기:
        //   - userMarkedChanged: 새 메모로 갱신 (빈 값이면 null 로 클리어)
        //   - preserveNote: 기존 DB 메모 그대로 유지 — 다음 다이얼로그에서 또 prefill 되도록 영속
        //   - 둘 다 아님: 기존 동작(메모 비우기) — 구버전 워처/명시적 클리어 의도
        if (userMarkedChanged) {
            String trimmed = changeNote == null ? "" : changeNote.trim();
            if (trimmed.length() > 2000) trimmed = trimmed.substring(0, 2000);
            order.setWorksheetChangeNote(trimmed.isEmpty() ? null : trimmed);
        } else if (!preserveNote) {
            order.setWorksheetChangeNote(null);
        }
        orderRepository.save(order);

        // DB 가 새 URL 로 바뀐 직후 옛 R2 객체 삭제(best-effort). 실패해도 다음 영구삭제 시 청소됨.
        if (oldWorksheetKey != null && !oldWorksheetKey.equals(originalKey) && !oldWorksheetKey.equals(androidKey)) {
            try {
                s3Client.deleteObject(DeleteObjectRequest.builder()
                        .bucket(bucket).key(oldWorksheetKey).build());
            } catch (Exception e) {
                log.warn("이전 지시서 PDF 삭제 실패 [{}/{}]: {}",
                        order.getOrderNumber(), oldWorksheetKey, e.getMessage());
            }
        }
        if (oldOriginalWorksheetKey != null
                && !oldOriginalWorksheetKey.equals(originalKey)
                && !oldOriginalWorksheetKey.equals(androidKey)
                && !oldOriginalWorksheetKey.equals(oldWorksheetKey)) {
            deleteR2BestEffort(oldOriginalWorksheetKey);
        }
        if (oldThumbnailKey != null) {
            String newThumbKey = extractKeyFromPublicUrl(thumbnailUrl);
            if (!oldThumbnailKey.equals(newThumbKey)) {
                try {
                    s3Client.deleteObject(DeleteObjectRequest.builder()
                            .bucket(bucket).key(oldThumbnailKey).build());
                } catch (Exception e) {
                    log.warn("이전 지시서 썸네일 삭제 실패 [{}/{}]: {}",
                            order.getOrderNumber(), oldThumbnailKey, e.getMessage());
                }
            }
        }

        Map<String, Object> body = new HashMap<>();
        body.put("orderNumber", order.getOrderNumber());
        body.put("worksheetPdfUrl", androidUrl);
        body.put("worksheetOriginalPdfUrl", originalUrl);
        body.put("worksheetThumbnailUrl", thumbnailUrl);
        return ResponseEntity.ok(body);
    }

    private void deleteR2BestEffort(String key) {
        if (key == null || key.isBlank()) return;
        try {
            s3Client.deleteObject(DeleteObjectRequest.builder()
                    .bucket(bucket).key(key).build());
        } catch (Exception ignored) {
            // best-effort cleanup after a failed upload
        }
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
