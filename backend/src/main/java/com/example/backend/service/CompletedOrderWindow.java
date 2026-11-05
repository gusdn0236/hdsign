package com.example.backend.service;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 작업완료(deletedAt != null) 목록을 '30일치씩' 나눠 내려주기 위한 기간 계산.
 *
 * 보관은 {@link #RETENTION_DAYS}(3년)인데 목록을 한 번에 다 주면 웹/현장/모바일 화면이 무거워지므로
 * page 0 = 최근 30일(오늘 포함), page 1 = 그 이전 30일 ... 식으로 나눈다.
 * 경계는 '날짜(자정)' 기준이라 같은 날 안에서는 폴링해도 창이 흔들리지 않는다.
 */
public final class CompletedOrderWindow {

    /** 작업완료 후 자동 완전삭제까지 보관 일수 (OrderTrashPurgeScheduler 가 사용). */
    // 2026-11-05: 180 → 1095일(3년). 명세서 탭에서 옛 지시서를 찾기 위함. 작업완료 탭은 화면에서 최근 30일만.
    // R2: 30일분 ~0.6GB 기준 3년 ~22GB → 무료 10GB 초과분만 과금(월 ~0.2달러).
    public static final int RETENTION_DAYS = 1095;

    /** 한 페이지(창) 길이. */
    public static final int WINDOW_DAYS = 30;

    /** 페이지 상한 — 보관기간을 다 덮고도 남는 값(안전장치). */
    public static final int MAX_PAGE = RETENTION_DAYS / WINDOW_DAYS + 2;

    private CompletedOrderWindow() {}

    /** [from, to) — page 번째 30일 창. */
    public static LocalDateTime[] range(int page) {
        LocalDate tomorrow = LocalDate.now().plusDays(1);
        LocalDate to = tomorrow.minusDays((long) WINDOW_DAYS * page);
        LocalDate from = to.minusDays(WINDOW_DAYS);
        return new LocalDateTime[]{from.atStartOfDay(), to.atStartOfDay()};
    }

    public static int clampPage(Integer page) {
        if (page == null || page < 0) return 0;
        return Math.min(page, MAX_PAGE);
    }
}
