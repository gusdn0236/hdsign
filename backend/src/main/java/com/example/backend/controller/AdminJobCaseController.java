package com.example.backend.controller;

import com.example.backend.dto.JobCaseDto;
import com.example.backend.service.JobCaseService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

/**
 * 작업 사례 API. /api/admin/** 라 SecurityConfig 가 ADMIN 권한을 자동 적용한다.
 */
@RestController
@RequestMapping("/api/admin/job-cases")
@RequiredArgsConstructor
public class AdminJobCaseController {

    private final JobCaseService jobCaseService;

    @GetMapping
    public ResponseEntity<List<JobCaseDto.Response>> list() {
        return ResponseEntity.ok(jobCaseService.list());
    }

    @GetMapping("/{id}")
    public ResponseEntity<JobCaseDto.Response> get(@PathVariable Long id) {
        return ResponseEntity.ok(jobCaseService.get(id));
    }

    @PostMapping
    public ResponseEntity<JobCaseDto.Response> create(@RequestBody JobCaseDto.SaveRequest req) {
        return ResponseEntity.ok(jobCaseService.create(req));
    }

    @PutMapping("/{id}")
    public ResponseEntity<JobCaseDto.Response> update(
            @PathVariable Long id,
            @RequestBody JobCaseDto.SaveRequest req
    ) {
        return ResponseEntity.ok(jobCaseService.update(id, req));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable Long id) {
        jobCaseService.delete(id);
        return ResponseEntity.ok(Map.of("message", "삭제되었습니다."));
    }

    // 첨부 파일 — 사례가 저장된 뒤(id 존재) 호출. kind: AI_SOURCE / PRICE / REFERENCE.
    @PostMapping("/{id}/files")
    public ResponseEntity<JobCaseDto.Response> addFile(
            @PathVariable Long id,
            @RequestParam("kind") String kind,
            @RequestParam("file") MultipartFile file
    ) {
        return ResponseEntity.ok(jobCaseService.addFile(id, kind, file));
    }

    @DeleteMapping("/{id}/files/{fileId}")
    public ResponseEntity<JobCaseDto.Response> deleteFile(
            @PathVariable Long id,
            @PathVariable Long fileId
    ) {
        return ResponseEntity.ok(jobCaseService.deleteFile(id, fileId));
    }
}
