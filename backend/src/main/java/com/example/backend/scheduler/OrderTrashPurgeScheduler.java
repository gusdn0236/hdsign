package com.example.backend.scheduler;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import com.example.backend.service.OrderArchiveService;
import com.example.backend.service.StorageUsageService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Component
@RequiredArgsConstructor
public class OrderTrashPurgeScheduler {

    private static final int RETENTION_DAYS = 30;

    private final OrderRepository orderRepository;
    private final OrderArchiveService orderArchiveService;
    private final StorageUsageService storageUsageService;

    // 매일 한국시간 새벽 3시: 작업완료(deletedAt) 로 이동된 지 30일 이상 경과한 주문을 완전 삭제.
    // 완전삭제 = R2 의 도안·미리보기·지시서 PDF·order_files 행 + Order 행까지 모두 하드 삭제.
    // (옛 아카이브 흐름 — 최소 레코드만 남기던 방식은 폐기. 30일 지나면 흔적 없이 사라진다.)
    // zone 미지정 시 Railway 컨테이너 타임존(UTC) → 한국시간 정오에 도는 셈이라 발주 피크에
    // R2 삭제 트래픽 발생. Asia/Seoul 명시로 새벽 시간대에 고정.
    @Scheduled(cron = "0 0 3 * * *", zone = "Asia/Seoul")
    @Transactional
    public void purgeExpiredTrash() {
        LocalDateTime cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS);
        List<Order> expired = orderRepository.findByDeletedAtBefore(cutoff);
        if (expired.isEmpty()) return;

        log.info("[TrashPurge] hard-deleting {} order(s) deleted before {}", expired.size(), cutoff);
        for (Order order : expired) {
            try {
                orderArchiveService.hardDeleteOrder(order);
            } catch (Exception e) {
                log.warn("[TrashPurge] failed to hard-delete order {}: {}", order.getId(), e.getMessage());
            }
        }
        // 다음 사용량 조회에서 줄어든 수치가 즉시 반영되도록 캐시 무효화.
        storageUsageService.invalidateCache();
    }
}
