package com.example.backend.controller;

import com.example.backend.dto.RateItemDto;
import com.example.backend.service.RateItemService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 단가 마스터 API. /api/admin/** 라 SecurityConfig 가 ADMIN 권한을 자동 적용한다.
 */
@RestController
@RequestMapping("/api/admin/rate-items")
@RequiredArgsConstructor
public class AdminRateItemController {

    private final RateItemService rateItemService;

    @GetMapping
    public ResponseEntity<List<RateItemDto>> list() {
        return ResponseEntity.ok(rateItemService.list());
    }

    @PostMapping
    public ResponseEntity<RateItemDto> create(@RequestBody RateItemDto dto) {
        return ResponseEntity.ok(rateItemService.create(dto));
    }

    @PutMapping("/{id}")
    public ResponseEntity<RateItemDto> update(@PathVariable Long id, @RequestBody RateItemDto dto) {
        return ResponseEntity.ok(rateItemService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable Long id) {
        rateItemService.delete(id);
        return ResponseEntity.ok(Map.of("message", "삭제되었습니다."));
    }
}
