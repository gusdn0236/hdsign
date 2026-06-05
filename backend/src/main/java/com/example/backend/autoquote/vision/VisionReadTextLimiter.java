package com.example.backend.autoquote.vision;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;

/**
 * 글자읽기(read_text / OCR) 일일 호출 한도 — 비용 보호용. 전 관리자 <b>공용 단일 카운터</b>이며
 * KST 자정에 리셋된다. 기본 100회({@code autoquote.vision.read-text-daily-limit}).
 *
 * <p>인메모리(앱 재시작/재배포 시 카운트 리셋)인 <b>소프트 캡</b>이다 — 재배포가 잦지 않은 운영에서
 * 충분하고, 우회는 서버에서 막힌다. 영속(재시작에도 유지)이 필요하면 DB 한 줄 테이블로 승격하면 된다.
 * 전체추출(report_work_order)에는 적용하지 않고 read_text 경로에서만 컨트롤러가 호출한다.
 */
@Component
public class VisionReadTextLimiter {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    private final int dailyLimit;
    private LocalDate day = LocalDate.now(KST);
    private int used = 0;

    public VisionReadTextLimiter(
            @Value("${autoquote.vision.read-text-daily-limit:100}") int dailyLimit) {
        this.dailyLimit = dailyLimit;
    }

    /** 날짜가 바뀌었으면 카운트를 0 으로 되돌린다(KST 자정 리셋). 모든 공개 메서드가 먼저 호출. */
    private void roll() {
        LocalDate today = LocalDate.now(KST);
        if (!today.equals(day)) {
            day = today;
            used = 0;
        }
    }

    /** 한도 도달(더 못 씀) 여부. */
    public synchronized boolean atLimit() {
        roll();
        return used >= dailyLimit;
    }

    /** 1회 소비(성공한 read_text 직후 컨트롤러가 호출). */
    public synchronized void consume() {
        roll();
        used++;
    }

    public synchronized int used() {
        roll();
        return used;
    }

    public synchronized int remaining() {
        roll();
        return Math.max(0, dailyLimit - used);
    }

    public int limit() {
        return dailyLimit;
    }
}
