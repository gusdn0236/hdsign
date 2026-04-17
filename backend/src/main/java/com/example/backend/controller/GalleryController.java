package com.example.backend.controller;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.service.GalleryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.io.IOException;
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
        return ResponseEntity.ok(galleryService.getImages(category));
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
