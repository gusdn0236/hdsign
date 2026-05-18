package com.example.backend.controller;

import com.example.backend.service.StorageUsageService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 관리자 — R2 버킷 사용량 조회. 작업완료 탭 상단 프로그레스 바가 사용한다.
 * 인증은 SecurityConfig 가 /api/admin/** 에 ROLE_ADMIN 을 요구하는 패턴을 따라간다.
 */
@RestController
@RequestMapping("/api/admin/storage")
@RequiredArgsConstructor
public class AdminStorageController {

    private final StorageUsageService storageUsageService;

    @GetMapping("/usage")
    public ResponseEntity<Map<String, Object>> usage() {
        return ResponseEntity.ok(storageUsageService.getUsage());
    }
}
