package com.example.backend.controller;

import com.example.backend.autoquote.analytics.SalesAnalyticsService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 매출분석 대시보드 — 상세 명세서 집계 통계를 관리자에게 서빙. 데이터 자산은 비공개(R2/파일시스템),
 * 응답에는 가공된 집계치만. 미프로비저닝이면 graceful 503.
 */
@RestController
@RequestMapping("/api/admin/analytics")
@PreAuthorize("hasRole('ADMIN')")
public class AdminAnalyticsController {

    private final SalesAnalyticsService analyticsService;

    public AdminAnalyticsController(SalesAnalyticsService analyticsService) {
        this.analyticsService = analyticsService;
    }

    @GetMapping("/sales")
    public ResponseEntity<?> sales() {
        SalesAnalyticsService.SalesAnalytics out = analyticsService.analytics();
        if (out == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "autoquote_data_unavailable"));
        }
        return ResponseEntity.ok(out);
    }

    /** 캐시 비우고 재집계 — 거래처관리 별칭/명세서 변경을 매출분석에 즉시 반영(재시작 불필요). */
    @PostMapping("/sales/refresh")
    public ResponseEntity<?> refresh() {
        analyticsService.clearCache();
        SalesAnalyticsService.SalesAnalytics out = analyticsService.analytics();
        if (out == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "autoquote_data_unavailable"));
        }
        return ResponseEntity.ok(out);
    }
}
