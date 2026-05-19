package com.example.backend.controller;

import com.example.backend.service.GoogleDriveBackupService;
import com.example.backend.service.StorageUsageService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 관리자 — 저장공간 사용량 조회.
 * <ul>
 *   <li>/usage          : R2 버킷 사용량 (작업완료 탭)</li>
 *   <li>/drive-usage    : 구글 드라이브 사용량 (현장작업완료사진 탭)</li>
 * </ul>
 * 인증은 SecurityConfig 가 /api/admin/** 에 ROLE_ADMIN 을 요구하는 패턴을 따라간다.
 */
@RestController
@RequestMapping("/api/admin/storage")
@RequiredArgsConstructor
public class AdminStorageController {

    private final StorageUsageService storageUsageService;
    private final GoogleDriveBackupService driveBackupService;

    @GetMapping("/usage")
    public ResponseEntity<Map<String, Object>> usage() {
        return ResponseEntity.ok(storageUsageService.getUsage());
    }

    @GetMapping("/drive-usage")
    public ResponseEntity<Map<String, Object>> driveUsage() {
        return ResponseEntity.ok(driveBackupService.getStorageUsage());
    }
}
