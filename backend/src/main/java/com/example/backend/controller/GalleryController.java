package com.example.backend.controller;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.service.GalleryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/gallery")
@RequiredArgsConstructor
public class GalleryController {

    private final GalleryService galleryService;

    @GetMapping
    public ResponseEntity<List<GalleryImageDto>> getImages(
        @RequestParam String category
    ) {
        // 갤러리 메타 목록 — 같은 사용자가 탭을 오가도 5분간 브라우저/CDN 캐시.
        // 관리자가 사진 추가해도 5분 내 반영(허용 범위). 매 페이지 진입마다 DB 조회 안 들어감.
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(galleryService.getImages(category));
    }

    @PostMapping("/upload")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> uploadImages(
        @RequestParam String category,
        @RequestParam(defaultValue = "전체") String subCategory,
        @RequestParam("files") List<MultipartFile> files
    ) {
        try {
            List<GalleryImageDto> uploaded = galleryService.uploadImages(category, subCategory, files);
            return ResponseEntity.ok(uploaded);
        } catch (IOException e) {
            return ResponseEntity.status(500).body(Map.of("message", "파일 저장 중 오류가 발생했습니다."));
        }
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> deleteImage(@PathVariable Long id) {
        try {
            galleryService.deleteImage(id);
            return ResponseEntity.ok(Map.of("message", "삭제되었습니다."));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(404).body(Map.of("message", e.getMessage()));
        } catch (IOException e) {
            return ResponseEntity.status(500).body(Map.of("message", "파일 삭제 중 오류가 발생했습니다."));
        }
    }
}
