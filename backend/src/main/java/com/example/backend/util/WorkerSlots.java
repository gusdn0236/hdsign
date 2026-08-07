package com.example.backend.util;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

// frontend/src/data/workers.js 의 SLOT_TO_WORKERS / OFFICE_WORKERS / matchesWorker 를
// 그대로 옮긴 것 — "내 지시서만 알림받기" 푸시 발송 대상 판정에 사용.
//
// ⚠️ 동기화 필수: workers.js 의 슬롯↔직원 매핑이 바뀌면 (직원 입퇴사, 슬롯 재배치 등)
// 이 파일도 반드시 같이 고쳐야 한다. 두 곳에 나뉘어 있는 건 알고 있는 트레이드오프 —
// 프론트는 목록 UI(ALL_WORKERS)에, 백엔드는 푸시 발송 판정에 각각 필요해서 당장은
// 복붙 동기화로 간다. 어긋나면 "내 지시서만" 알림이 누락되거나 잘못 갈 수 있음.
public final class WorkerSlots {

    private WorkerSlots() {}

    private static final Map<String, List<String>> SLOT_TO_WORKERS = Map.ofEntries(
            Map.entry("캡/일체형작업실", List.of("김진섭", "김명수")),
            Map.entry("시트/도안실", List.of("김현우")),
            Map.entry("에폭시실", List.of("이경숙", "김순희")),
            Map.entry("아크릴/실리콘네온", List.of("신문식")),
            Map.entry("후레임실", List.of("박철진")),
            Map.entry("도장실", List.of("왕종길")),
            Map.entry("레이져용접", List.of("김길수")),
            Map.entry("최창영부장", List.of("김민우")),
            Map.entry("조립부", List.of("이휘원")),
            Map.entry("아크릴부(레이져)", List.of("이재호")),
            Map.entry("배송1팀", List.of("이창율")),
            Map.entry("배송2팀", List.of()),
            Map.entry("홍철웅팀장", List.of()),
            Map.entry("LED조립", List.of("정숙자")),
            Map.entry("고무스카시(CNC)", List.of("신문식")),
            Map.entry("이휘원실장", List.of("이휘원"))
    );

    private static final Set<String> OFFICE_WORKERS = Set.of("박혜영", "김종임", "임서현");

    // worksheetSlots: order.getDepartmentSlots() 를 콤마로 split 한 리스트.
    public static boolean matchesWorker(List<String> worksheetSlots, String worker) {
        if (worker == null || worker.isBlank()) return false;
        if (OFFICE_WORKERS.contains(worker)) return true; // 사무실 직원은 전 부서 지시서를 다 본다

        Set<String> mySlots = SLOT_TO_WORKERS.entrySet().stream()
                .filter(e -> e.getValue().contains(worker))
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
        if (mySlots.isEmpty()) return false;
        if (worksheetSlots == null || worksheetSlots.isEmpty()) return false;

        return worksheetSlots.stream().anyMatch(mySlots::contains);
    }
}
