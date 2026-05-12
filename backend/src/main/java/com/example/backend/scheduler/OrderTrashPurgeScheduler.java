package com.example.backend.scheduler;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import com.example.backend.service.OrderArchiveService;
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

    // 매일 한국시간 새벽 3시: 휴지통에서 30일 이상 경과한 작업을 "아카이브"로 정리.
    // 영구삭제 = R2 의 도안·미리보기·지시서 PDF·order_files 행을 전부 지우되, 현장 프로그램이
    // 옛 지시서를 다시 찾을 수 있도록 최소 레코드(거래처·제목·발주일·납기·사양메모·파일명)는 남긴다.
    // 그 최소 레코드의 진짜 삭제는 관리자 아카이브 탭 [완전삭제] 에서만.
    // zone 미지정 시 Railway 컨테이너 타임존(UTC) → 한국시간 정오에 도는 셈이라 발주 피크에
    // R2 삭제 트래픽 발생. Asia/Seoul 명시로 새벽 시간대에 고정.
    @Scheduled(cron = "0 0 3 * * *", zone = "Asia/Seoul")
    @Transactional
    public void purgeExpiredTrash() {
        LocalDateTime cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS);
        List<Order> expired = orderRepository.findByDeletedAtBeforeAndPurgedAtIsNull(cutoff);
        if (expired.isEmpty()) return;

        log.info("[TrashPurge] archiving {} order(s) deleted before {}", expired.size(), cutoff);
        for (Order order : expired) {
            try {
                orderArchiveService.purgeFilesKeepRecord(order);
            } catch (Exception e) {
                log.warn("[TrashPurge] failed to archive order {}: {}", order.getId(), e.getMessage());
            }
        }
    }
}
