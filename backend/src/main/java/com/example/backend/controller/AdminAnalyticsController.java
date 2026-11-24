package com.example.backend.controller;

import com.example.backend.autoquote.analytics.SalesAnalyticsService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;


/**
 * 매출분석 대시보드 — 홈페이지 완료 명세서 집계 통계를 관리자에게 서빙(30분마다 자동 재집계).
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
        return ResponseEntity.ok(analyticsService.analytics());
    }

    /** 지금 바로 다시 집계 — 30분 자동 주기를 기다리지 않고. */
    @PostMapping("/sales/refresh")
    public ResponseEntity<?> refresh() {
        return ResponseEntity.ok(analyticsService.rebuild());
    }
}
