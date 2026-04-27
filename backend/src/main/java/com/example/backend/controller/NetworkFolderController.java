package com.example.backend.controller;

import com.example.backend.entity.ClientUser;
import com.example.backend.repository.ClientUserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 워처가 \\Main\...\거래처 디렉토리 리스팅을 푸시하면 메모리 캐시에 보관.
 * 관리자 모달이 거래처 폴더명 자동완성용으로 GET 한다.
 *
 * 백엔드(Railway)는 사내 SMB 경로에 직접 접근할 수 없으므로 워처가 유일한 출처.
 * 캐시이므로 서버 재시작 시 비어도 워처가 다시 푸시해주면 복구된다.
 *
 * 단일 이름변경 자동감지: 직전 sync 결과와 비교해서 정확히 1개가 사라지고 1개가 추가됐다면
 * 폴더 rename 으로 추정 → networkFolderName 이 옛 이름인 거래처를 신규명으로 일괄 갱신.
 * 다중 변경(2개 이상 add/remove) 또는 신규명 충돌 시에는 자동 변경하지 않음 — 짝짓기를
 * 신뢰할 수 없거나 admin 의 수동 정리가 필요한 상황이라 보수적으로 동작.
 */
@Slf4j
@RestController
@RequestMapping("/api/admin/network-folders")
@RequiredArgsConstructor
public class NetworkFolderController {

    private static final AtomicReference<Snapshot> CACHE = new AtomicReference<>(new Snapshot(List.of(), null));

    private final ClientUserRepository clientUserRepository;

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
    @Transactional
    public ResponseEntity<Map<String, Object>> sync(@RequestBody SyncRequest req) {
        List<String> incoming = req != null && req.folders != null ? req.folders : List.of();
        List<String> cleaned = new ArrayList<>();
        for (String name : incoming) {
            if (name == null) continue;
            String trimmed = name.trim();
            if (!trimmed.isEmpty()) cleaned.add(trimmed);
        }
        Snapshot prev = CACHE.get();
        Snapshot next = new Snapshot(List.copyOf(cleaned), Instant.now());

        // 캐시 갱신 전에 rename 감지 — prev 기준으로 비교해야 의미 있음.
        Map<String, Object> renameInfo = detectAndApplyRename(prev.folders, next.folders);

        CACHE.set(next);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("count", cleaned.size());
        body.put("syncedAt", next.syncedAt.toString());
        if (renameInfo != null) body.put("rename", renameInfo);
        return ResponseEntity.ok(body);
    }

    /**
     * 직전 폴더 목록(prev)과 신규 폴더 목록(next)을 비교해 폴더 이름변경을 감지.
     *  - 정확히 1개 사라지고 1개 추가된 경우만 rename 으로 본다.
     *    (2개 이상 변경은 짝짓기 모호 — 삭제/생성을 우연히 같은 sync 사이클에 한 케이스를
     *    잘못된 rename 으로 매핑해 거래처 networkFolderName 을 망가뜨릴 수 있어 보류.)
     *  - 신규명을 이미 다른 거래처가 networkFolderName 으로 쓰고 있으면 충돌이라
     *    자동 변경 안 함 (admin 이 수동 정리).
     *  - 첫 sync(prev 비어있음) 도 비교 기준이 없어 자동 매핑 안 함.
     * 일치하는 거래처가 있으면 networkFolderName 을 신규명으로 갱신하고 결과 정보를 반환.
     */
    private Map<String, Object> detectAndApplyRename(List<String> prev, List<String> next) {
        if (prev == null || prev.isEmpty()) return null;
        Set<String> prevSet = new HashSet<>(prev);
        Set<String> nextSet = new HashSet<>(next);
        List<String> removed = new ArrayList<>();
        for (String p : prev) if (!nextSet.contains(p)) removed.add(p);
        List<String> added = new ArrayList<>();
        for (String n : next) if (!prevSet.contains(n)) added.add(n);
        if (removed.size() != 1 || added.size() != 1) return null;

        String oldName = removed.get(0);
        String newName = added.get(0);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("oldName", oldName);
        result.put("newName", newName);

        List<ClientUser> all = clientUserRepository.findAll();
        boolean conflict = all.stream()
                .anyMatch(c -> newName.equals(c.getNetworkFolderName()));
        if (conflict) {
            result.put("updatedClients", 0);
            result.put("skipped", "newNameAlreadyUsed");
            log.info("폴더 이름변경 감지 — 신규명 '{}' 가 이미 다른 거래처에 사용 중이라 자동 매핑 생략 (구명: '{}')",
                    newName, oldName);
            return result;
        }

        int updated = 0;
        for (ClientUser c : all) {
            if (oldName.equals(c.getNetworkFolderName())) {
                c.setNetworkFolderName(newName);
                clientUserRepository.save(c);
                updated++;
            }
        }
        result.put("updatedClients", updated);
        log.info("폴더 이름변경 자동감지: '{}' → '{}' (거래처 {}건 업데이트)", oldName, newName, updated);
        return result;
    }

    public static class SyncRequest {
        public List<String> folders;
    }

    private record Snapshot(List<String> folders, Instant syncedAt) {}
}
