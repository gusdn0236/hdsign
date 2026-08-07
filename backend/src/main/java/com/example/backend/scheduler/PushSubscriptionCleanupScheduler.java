package com.example.backend.scheduler;

import com.example.backend.entity.PushSubscription;
import com.example.backend.repository.PushSubscriptionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

// 죽은 푸시 구독의 2차 방어선.
//
// 1차는 WorksheetPushNotifier — 발송 시 404/410 이 오면 즉시 지운다. 대부분은 여기서 걸린다.
// 다만 mode=MINE 인데 담당 슬롯이 한 번도 안 걸린 구독은 발송 시도 자체가 없어 1차에 안 잡힌다.
// (퇴사한 직원 기기, 이름을 바꾼 뒤 방치된 구독 등)
//
// 그래서 "구독한 지 RETENTION_DAYS 넘도록 단 한 번도 발송에 성공한 적 없는" 구독을 주기적으로
// 지운다. 살아있는 기기라면 그 사이 한 번은 알림을 받았을 것이므로 오탐 위험이 낮고,
// 잘못 지워져도 사용자가 앱에서 알림을 다시 켜면 즉시 재구독된다(손실 없음).
@Slf4j
@Component
@RequiredArgsConstructor
public class PushSubscriptionCleanupScheduler {

    private static final int RETENTION_DAYS = 180;

    private final PushSubscriptionRepository pushSubscriptionRepository;

    // 매주 일요일 한국시간 새벽 4시 — 다른 배치(3시 휴지통 정리)와 겹치지 않게.
    @Scheduled(cron = "0 0 4 * * SUN", zone = "Asia/Seoul")
    @Transactional
    public void purgeStaleSubscriptions() {
        LocalDateTime cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS);
        List<PushSubscription> stale =
                pushSubscriptionRepository.findByCreatedAtBeforeAndLastSuccessAtIsNull(cutoff);
        if (stale.isEmpty()) return;

        log.info("[PushCleanup] {}일간 한 번도 도달하지 못한 구독 {}건 삭제", RETENTION_DAYS, stale.size());
        pushSubscriptionRepository.deleteAll(stale);
    }
}
