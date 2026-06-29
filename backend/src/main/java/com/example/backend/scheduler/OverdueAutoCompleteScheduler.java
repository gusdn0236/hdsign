package com.example.backend.scheduler;

import com.example.backend.entity.Order;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

/**
 * 매일 한국시간 오전 10시: 납기일이 지난 '작업중(IN_PROGRESS)' 주문을 자동으로 작업완료 처리한다.
 *
 * 배경: 납기 지난 건은 프론트 '완료 검토(지연)' 목록에 모여, 사무실이 한 건씩 검토 후 작업완료로
 * 넘겨야 했다. 바빠서 제때 못 넘기면 휴대폰 발주관리에 '지연'이 계속 최상단에 떠 거슬렸음.
 * → 매일 아침 자동으로 작업완료(휴지통=완료 아카이브)로 넘긴다.
 *
 * 범위(2026-06-29 결정): 납기일 < 오늘(KST) 이면서 status=IN_PROGRESS, 휴지통 안 간 건만.
 *   - 접수(RECEIVED, 아직 미작업) 건은 자동완료하면 위험하므로 제외.
 *   - 이미 COMPLETED 인 옛 데이터도 제외(여기선 IN_PROGRESS 만 잡음).
 * '작업완료' 처리 = AdminOrderController.moveToTrash 와 동일하게 status=COMPLETED + deletedAt=now.
 *
 * 30일 뒤 자동 완전삭제는 기존 OrderTrashPurgeScheduler 가 deletedAt 기준으로 그대로 처리한다.
 *
 * zone="Asia/Seoul" 명시 — Railway 컨테이너 타임존(UTC)에 두면 한국 새벽에 도는 문제 방지.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OverdueAutoCompleteScheduler {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    private final OrderRepository orderRepository;

    @Scheduled(cron = "0 0 10 * * *", zone = "Asia/Seoul")
    @Transactional
    public void autoCompleteOverdue() {
        LocalDate today = LocalDate.now(KST);
        List<Order> overdue = orderRepository.findByStatusAndDeletedAtIsNullAndDueDateBefore(
                Order.OrderStatus.IN_PROGRESS, today);
        if (overdue.isEmpty()) return;

        LocalDateTime now = LocalDateTime.now();
        log.info("[OverdueAutoComplete] auto-completing {} overdue IN_PROGRESS order(s) (dueDate < {})",
                overdue.size(), today);
        for (Order order : overdue) {
            order.setStatus(Order.OrderStatus.COMPLETED);
            order.setDeletedAt(now);
        }
        orderRepository.saveAll(overdue);
    }
}
