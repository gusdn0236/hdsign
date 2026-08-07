package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.entity.PushSubscription;
import com.example.backend.repository.PushSubscriptionRepository;
import com.example.backend.util.WorkerSlots;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

// 지시서가 "재업로드로 실제 변경"됐을 때만 호출한다(최초 업로드는 호출하지 않음 — 호출부에서 판단).
// ALL 구독자는 무조건, MINE 구독자는 이번에 바뀐 지시서의 departmentSlots 와 본인 슬롯이
// 겹칠 때만 발송 대상.
//
// 발송은 @Async — 구독 기기가 20대면 푸시 서버로 HTTP 왕복을 20번 하는데, 동기로 돌리면
// 지시서 재업로드 응답이 그걸 전부 기다린다. 실제 발송은 dispatchAsync 로 넘긴다.
//
// 죽은 구독 정리: 푸시 서버가 404/410 을 주면 그 구독은 영구히 죽은 것이라 즉시 삭제한다.
// (기기 초기화·PWA 재설치·알림 차단 시 발생. 안 지우면 지시서 변경 때마다 헛발송이 누적된다.)
@Slf4j
@Service
@RequiredArgsConstructor
public class WorksheetPushNotifier {

    // lastSuccessAt 은 "이 구독이 아직 살아있나"를 보는 청소 배치용 값이라 분 단위 정밀도가 필요 없다.
    // 매 발송마다 saveAll 하면 기기 수만큼 UPDATE 가 나가므로, 이 시간보다 오래된 것만 갱신한다.
    private static final int LAST_SUCCESS_REFRESH_HOURS = 24;

    private final PushSubscriptionRepository pushSubscriptionRepository;
    private final WebPushService webPushService;
    // 자기 자신을 프록시로 다시 잡기 위한 참조. this.dispatchAsync(...) 로 직접 부르면
    // 프록시를 거치지 않아 @Async 가 무시되고 그대로 동기 실행된다.
    private final ObjectProvider<WorksheetPushNotifier> selfProvider;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public void notifyWorksheetChanged(Order order) {
        if (!webPushService.isEnabled()) return;

        // ⚠️ client 는 LAZY 라 @Async 스레드에서 접근하면 "no session" 이 난다.
        // 상호명·슬롯은 반드시 트랜잭션이 살아있는 호출 스레드에서 미리 뽑아 값으로 넘긴다
        // (GoogleDriveBackupService.uploadEvidenceAsync 와 같은 패턴).
        selfProvider.getObject().dispatchAsync(
                order.getOrderNumber(), resolveLabel(order), splitCsv(order.getDepartmentSlots()));
    }

    @Async
    public void dispatchAsync(String orderNumber, String label, List<String> slots) {
        List<PushSubscription> subs = pushSubscriptionRepository.findAll();
        if (subs.isEmpty()) return;

        String payload = buildPayload(orderNumber, label);

        // 대상 구독의 발송을 한꺼번에 띄운다 — 직렬로 돌리면 기기 수 × 왕복시간이 그대로 쌓여서
        // 기기 20대면 이 스레드가 수 초~수십 초를 잡아먹는다(사진 백업·메일과 공유하는 풀이다).
        // 동시에 띄우면 전체 소요가 "가장 느린 한 건" 으로 줄고, 그마저 요청 타임아웃으로 묶여 있다.
        List<InFlight> inFlight = new ArrayList<>();
        for (PushSubscription sub : subs) {
            boolean shouldSend = switch (sub.getMode()) {
                case ALL -> true;
                case MINE -> WorkerSlots.matchesWorker(slots, sub.getWorker());
            };
            if (!shouldSend) continue;

            inFlight.add(new InFlight(sub, webPushService.sendAsync(sub, payload)));
        }
        if (inFlight.isEmpty()) return;

        List<Long> deadIds = new ArrayList<>();
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime refreshCutoff = now.minusHours(LAST_SUCCESS_REFRESH_HOURS);
        List<PushSubscription> delivered = new ArrayList<>();

        for (InFlight pending : inFlight) {
            PushSubscription sub = pending.subscription();
            WebPushService.SendResult result;
            try {
                // sendAsync 는 실패도 FAILED 로 접어서 정상 완료시키므로 여기서 터질 일은 없다.
                // 그래도 여기서 예외가 새면 아래 정리 로직 전체가 날아가므로 방어한다.
                result = pending.future().join();
            } catch (Exception e) {
                log.warn("푸시 발송 결과 수집 실패 [id={}]: {}", sub.getId(), e.getMessage());
                continue;
            }

            if (result == WebPushService.SendResult.GONE) {
                deadIds.add(sub.getId());
            } else if (result == WebPushService.SendResult.OK) {
                // 마지막 성공 시각 기록 — 오래도록 한 번도 성공 못 한 구독을 청소 배치가 걸러낸다.
                LocalDateTime last = sub.getLastSuccessAt();
                if (last == null || last.isBefore(refreshCutoff)) {
                    sub.setLastSuccessAt(now);
                    delivered.add(sub);
                }
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

    private String buildPayload(String orderNumber, String label) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("title", "지시서가 변경되었습니다");
        data.put("body", label + " 지시서를 다시 확인해주세요");
        data.put("url", "/m/worksheets/" + orderNumber);
        data.put("orderNumber", orderNumber);
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

    // 발송 중인 요청과 그 대상 구독을 짝지어 둔다 — 결과를 받아서 어느 구독을 지울지 판단해야 한다.
    private record InFlight(PushSubscription subscription,
                            CompletableFuture<WebPushService.SendResult> future) {
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
