package com.example.backend.controller;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 워처가 \\Main\...\거래처 디렉토리 리스팅을 푸시하면 메모리 캐시에 보관.
 * 관리자 모달이 거래처 폴더명 자동완성용으로 GET 한다.
 *
 * 백엔드(Railway)는 사내 SMB 경로에 직접 접근할 수 없으므로 워처가 유일한 출처.
 * 캐시이므로 서버 재시작 시 비어도 워처가 다시 푸시해주면 복구된다.
 */
@RestController
@RequestMapping("/api/admin/network-folders")
@RequiredArgsConstructor
public class NetworkFolderController {

    private static final AtomicReference<Snapshot> CACHE = new AtomicReference<>(new Snapshot(List.of(), null));

    /** 다른 컨트롤러(거래처 일괄 등록 등)에서 캐시 폴더 목록을 읽기 위한 헬퍼. */
    public static List<String> currentFolders() {
        return CACHE.get().folders;
    }

    public static Instant currentSyncedAt() {
        return CACHE.get().syncedAt;
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> list() {
        Snapshot snap = CACHE.get();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("folders", snap.folders);
        body.put("syncedAt", snap.syncedAt != null ? snap.syncedAt.toString() : null);
        return ResponseEntity.ok(body);
    }

    @PostMapping("/sync")
    public ResponseEntity<Map<String, Object>> sync(@RequestBody SyncRequest req) {
        List<String> incoming = req != null && req.folders != null ? req.folders : List.of();
        List<String> cleaned = new ArrayList<>();
        for (String name : incoming) {
            if (name == null) continue;
            String trimmed = name.trim();
            if (!trimmed.isEmpty()) cleaned.add(trimmed);
        }
        Snapshot snap = new Snapshot(List.copyOf(cleaned), Instant.now());
        CACHE.set(snap);
        return ResponseEntity.ok(Map.of("count", cleaned.size(), "syncedAt", snap.syncedAt.toString()));
    }

    public static class SyncRequest {
        public List<String> folders;
    }

    private record Snapshot(List<String> folders, Instant syncedAt) {}
}
