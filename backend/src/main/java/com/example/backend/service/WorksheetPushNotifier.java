package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.entity.PushSubscription;
import com.example.backend.repository.PushSubscriptionRepository;
import com.example.backend.util.WorkerSlots;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// 지시서가 "재업로드로 실제 변경"됐을 때만 호출한다(최초 업로드는 호출하지 않음 — 호출부에서 판단).
// ALL 구독자는 무조건, MINE 구독자는 이번에 바뀐 지시서의 departmentSlots 와 본인 슬롯이
// 겹칠 때만 발송 대상.
//
// 죽은 구독 정리: 푸시 서버가 404/410 을 주면 그 구독은 영구히 죽은 것이라 즉시 삭제한다.
// (기기 초기화·PWA 재설치·알림 차단 시 발생. 안 지우면 지시서 변경 때마다 헛발송이 누적된다.)
@Slf4j
@Service
@RequiredArgsConstructor
public class WorksheetPushNotifier {

    private final PushSubscriptionRepository pushSubscriptionRepository;
    private final WebPushService webPushService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public void notifyWorksheetChanged(Order order) {
        if (!webPushService.isEnabled()) return;

        List<PushSubscription> subs = pushSubscriptionRepository.findAll();
        if (subs.isEmpty()) return;

        List<String> slots = splitCsv(order.getDepartmentSlots());
        String payload = buildPayload(order);

        List<Long> deadIds = new ArrayList<>();
        LocalDateTime now = LocalDateTime.now();
        List<PushSubscription> delivered = new ArrayList<>();

        for (PushSubscription sub : subs) {
            boolean shouldSend = switch (sub.getMode()) {
                case ALL -> true;
                case MINE -> WorkerSlots.matchesWorker(slots, sub.getWorker());
            };
            if (!shouldSend) continue;

            WebPushService.SendResult result = webPushService.send(sub, payload);
            if (result == WebPushService.SendResult.GONE) {
                deadIds.add(sub.getId());
            } else if (result == WebPushService.SendResult.OK) {
                // 마지막 성공 시각 기록 — 오래도록 한 번도 성공 못 한 구독을 청소 배치가 걸러낸다.
                sub.setLastSuccessAt(now);
                delivered.add(sub);
            }
        }

        // 발송 루프가 끝난 뒤 일괄 정리 — 순회 중 삭제하면 트랜잭션/컬렉션이 꼬인다.
        if (!deadIds.isEmpty()) {
            try {
                pushSubscriptionRepository.deleteAllById(deadIds);
                log.info("만료된 푸시 구독 {}건 삭제", deadIds.size());
            } catch (Exception e) {
                log.warn("만료 푸시 구독 삭제 실패: {}", e.getMessage());
            }
        }
        if (!delivered.isEmpty()) {
            try {
                pushSubscriptionRepository.saveAll(delivered);
            } catch (Exception e) {
                log.warn("푸시 구독 lastSuccessAt 갱신 실패: {}", e.getMessage());
            }
        }
    }

    private String buildPayload(Order order) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("title", "지시서가 변경되었습니다");
        data.put("body", resolveLabel(order) + " 지시서를 다시 확인해주세요");
        data.put("url", "/m/worksheets/" + order.getOrderNumber());
        data.put("orderNumber", order.getOrderNumber());
        try {
            return objectMapper.writeValueAsString(data);
        } catch (Exception e) {
            // 직렬화가 실패할 일은 거의 없지만, 실패해도 발송 자체를 막지 않도록 최소 payload 로 폴백.
            log.warn("푸시 payload 직렬화 실패: {}", e.getMessage());
            return "{\"title\":\"지시서가 변경되었습니다\",\"url\":\"/m/worksheets\"}";
        }
    }

    // 알림에 띄울 이름 — 주문번호보다 상호명이 현장에서 훨씬 알아보기 쉽다.
    // client 는 LAZY 라 세션이 닫힌 상황이면 접근 시 예외가 날 수 있으므로 감싸고,
    // 상호명이 없거나 못 읽으면 주문번호로 폴백한다(알림 자체는 반드시 나가야 함).
    private String resolveLabel(Order order) {
        try {
            if (order.getClient() != null) {
                String company = order.getClient().getCompanyName();
                if (company != null && !company.isBlank()) return company.trim();
            }
        } catch (Exception e) {
            log.warn("푸시 상호명 조회 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
        }
        return order.getOrderNumber();
    }

    private List<String> splitCsv(String csv) {
        List<String> out = new ArrayList<>();
        if (csv == null || csv.isBlank()) return out;
        for (String part : csv.split(",")) {
            String t = part.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }
}
