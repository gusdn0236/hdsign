package com.example.backend.controller;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.OrderFileRepository;
import com.example.backend.service.GalleryService;
import com.example.backend.util.WorkerTagMapping;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 관리자 페이지 "현장작업완료사진" 탭 전용.
 * QR 모바일 카메라로 들어온 사진(=OrderFile.isEvidence=true)만 거래처/태그 필터 + 페이지네이션으로 반환.
 * 일괄 삭제: R2 객체 + DB 행 둘 다 정리.
 */
@Slf4j
@RestController
@RequestMapping("/api/admin/evidence")
@RequiredArgsConstructor
public class AdminEvidenceController {

    private final OrderFileRepository orderFileRepository;
    private final S3Client s3Client;
    private final GalleryService galleryService;

    @Value("${r2.bucket}")
    private String bucket;

    @GetMapping
    public ResponseEntity<?> listEvidence(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String tag,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "60") int size
    ) {
        if (size > 200) size = 200;
        if (size < 1) size = 60;
        if (page < 0) page = 0;

        String normalizedQ = (q == null || q.isBlank()) ? null : q.trim();
        List<String> workers = (tag == null || tag.isBlank())
                ? null
                : WorkerTagMapping.workersForTag(tag);

        Pageable pageable = PageRequest.of(page, size);
        Page<OrderFile> result = (workers != null && !workers.isEmpty())
                ? orderFileRepository.findEvidenceByWorkers(normalizedQ, workers, pageable)
                : orderFileRepository.findEvidence(normalizedQ, pageable);

        List<Map<String, Object>> items = result.getContent().stream()
                .map(AdminEvidenceController::toItem)
                .toList();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("content", items);
        body.put("page", result.getNumber());
        body.put("size", result.getSize());
        body.put("totalElements", result.getTotalElements());
        body.put("totalPages", result.getTotalPages());
        body.put("hasNext", result.hasNext());
        body.put("availableTags", WorkerTagMapping.TAGS);
        return ResponseEntity.ok(body);
    }

    /**
     * 일괄 삭제 — DB 행 + R2 객체 둘 다 정리. isEvidence=true 인 행만 처리(다른 종류 파일이 섞여 들어와도 무시).
     * 본문: { "ids": [1, 2, 3] }
     */
    @DeleteMapping
    @Transactional
    public ResponseEntity<?> deleteBulk(@RequestBody Map<String, Object> body) {
        Object raw = body == null ? null : body.get("ids");
        if (!(raw instanceof List<?> rawList) || rawList.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "ids 가 비어있습니다."));
        }
        List<Long> ids = new ArrayList<>();
        for (Object o : rawList) {
            if (o instanceof Number n) ids.add(n.longValue());
            else if (o instanceof String s) {
                try { ids.add(Long.parseLong(s.trim())); } catch (NumberFormatException ignored) {}
            }
        }
        if (ids.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "유효한 id 가 없습니다."));
        }

        List<OrderFile> files = orderFileRepository.findAllById(ids);
        int deletedDb = 0;
        int deletedR2 = 0;
        int skippedNonEvidence = 0;
        for (OrderFile f : files) {
            if (!Boolean.TRUE.equals(f.getIsEvidence())) {
                skippedNonEvidence++;
                continue;
            }
            // R2 best-effort — 실패해도 DB 행은 지운다(파일 누수가 단절 누수보다 낫다).
            String key = f.getStoredName();
            if (key != null && !key.isBlank()) {
                try {
                    s3Client.deleteObject(DeleteObjectRequest.builder()
                            .bucket(bucket).key(key).build());
                    deletedR2++;
                } catch (Exception e) {
                    log.warn("증거사진 R2 삭제 실패 [{}/{}]: {}", f.getId(), key, e.getMessage());
                }
            }
            orderFileRepository.delete(f);
            deletedDb++;
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("requested", ids.size());
        resp.put("deletedDb", deletedDb);
        resp.put("deletedR2", deletedR2);
        resp.put("skippedNonEvidence", skippedNonEvidence);
        return ResponseEntity.status(HttpStatus.OK).body(resp);
    }

    /**
     * 증거사진 한 장을 갤러리로 등록. R2 server-side copy 로 사본을 만들고 gallery_images 행 추가.
     * 원본 증거사진은 그대로 둔다.
     * 본문: { "category": "galva", "subCategory": "갈바 전/후광" }
     */
    @PostMapping("/{id}/add-to-gallery")
    public ResponseEntity<?> addToGallery(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        String category = body == null ? null : (body.get("category") instanceof String s ? s.trim() : null);
        String subCategory = body == null ? null : (body.get("subCategory") instanceof String s ? s.trim() : null);
        if (category == null || category.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "category 가 필요합니다."));
        }
        if (subCategory == null || subCategory.isBlank()) subCategory = "전체";
        try {
            GalleryImageDto created = galleryService.addEvidenceToGallery(id, category, subCategory);
            return ResponseEntity.ok(created);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            log.warn("증거사진 갤러리 등록 실패 [id={}]: {}", id, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("message", "갤러리 등록에 실패했습니다."));
        }
    }

    private static Map<String, Object> toItem(OrderFile f) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", f.getId());
        m.put("fileUrl", f.getFileUrl());
        m.put("originalName", f.getOriginalName());
        m.put("fileSize", f.getFileSize());
        m.put("contentType", f.getContentType());
        m.put("uploadedDepartment", f.getUploadedDepartment());
        m.put("tag", WorkerTagMapping.tagOf(f.getUploadedDepartment()));
        m.put("createdAt", f.getCreatedAt());
        if (f.getOrder() != null) {
            m.put("orderId", f.getOrder().getId());
            m.put("orderNumber", f.getOrder().getOrderNumber());
            m.put("orderTitle", f.getOrder().getTitle());
            if (f.getOrder().getClient() != null) {
                m.put("clientId", f.getOrder().getClient().getId());
                m.put("companyName", f.getOrder().getClient().getCompanyName());
            }
        }
        return m;
    }
}
