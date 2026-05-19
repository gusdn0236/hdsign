package com.example.backend.util;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 증거사진 업로더(=OrderFile.uploadedDepartment) 이름을 태그로 매핑.
 * 매핑되지 않은 작업자는 태그 없음(null) — 태그 필터에서 잡히지 않는다.
 * 작업자 이름이 변경되면 이 매핑만 수정하면 됨.
 */
public final class WorkerTagMapping {

    private WorkerTagMapping() {}

    /** 태그 → 해당 태그로 묶이는 작업자 이름 목록. 입력 순서가 곧 UI 필터 버튼 노출 순서. */
    public static final Map<String, List<String>> TAG_TO_WORKERS;

    /** 모든 태그명 — UI 필터 버튼 순서 유지. */
    public static final List<String> TAGS;

    static {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("완조립", List.of("김진섭", "김현우", "김명수", "이휘원"));
        m.put("LED", List.of("이경숙", "김순희", "정숙자"));
        m.put("CNC", List.of("김민우", "신문식"));
        m.put("5층아크릴", List.of("이재호"));
        TAG_TO_WORKERS = Map.copyOf(m);
        TAGS = List.copyOf(m.keySet());
    }

    /** 작업자 이름 → 태그. trim 후 정확히 일치하는 경우만. 매핑 없으면 null. */
    public static String tagOf(String worker) {
        if (worker == null) return null;
        String trimmed = worker.trim();
        if (trimmed.isEmpty()) return null;
        for (Map.Entry<String, List<String>> entry : TAG_TO_WORKERS.entrySet()) {
            if (entry.getValue().contains(trimmed)) return entry.getKey();
        }
        return null;
    }

    /** 태그 → 해당 태그의 작업자 이름 목록. 매핑 없는 태그면 null. */
    public static List<String> workersForTag(String tag) {
        if (tag == null) return null;
        return TAG_TO_WORKERS.get(tag.trim());
    }
}
