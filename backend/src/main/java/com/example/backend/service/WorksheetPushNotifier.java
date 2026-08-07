package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.entity.PushSubscription;
import com.example.backend.repository.PushSubscriptionRepository;
import com.example.backend.util.WorkerSlots;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// 지시서가 "재업로드로 실제 변경"됐을 때만 호출한다(최초 업로드는 호출하지 않음 — 호출부에서 판단).
// ALL 구독자는 무조건, MINE 구독자는 이번에 바뀐 지시서의 departmentSlots 와 본인 슬롯이
// 겹칠 때만 발송 대상.
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

        for (PushSubscription sub : subs) {
            boolean shouldSend = switch (sub.getMode()) {
                case ALL -> true;
                case MINE -> WorkerSlots.matchesWorker(slots, sub.getWorker());
            };
            if (shouldSend) {
                webPushService.send(sub, payload);
            }
        }
    }

    private String buildPayload(Order order) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("title", "지시서가 변경되었습니다");
        data.put("body", order.getOrderNumber() + " 지시서를 다시 확인해주세요");
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
