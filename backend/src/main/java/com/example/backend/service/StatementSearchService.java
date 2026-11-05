package com.example.backend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 명세서 검색 — 저장된 명세서(autoquote_estimate.grid_json)의 '행' 단위로 찾는다.
 *
 * 조건 종류별 규칙(명세서 탭 검색창의 칩 하나 = 값 하나):
 *  - codes   : 품목코드 — 여러 개면 OR(한 행엔 코드가 하나라서). 공백 제거·대소문자 무시 '일치'.
 *  - specs   : 규격 — 여러 개면 OR. '500*100' / '500x100' / '500 100' 같은 표기, 가로·세로 뒤집힘도 같은 것.
 *              숫자 하나만 주면 그 숫자가 규격에 들어간 행.
 *  - texts   : 품목 텍스트 — 여러 개면 AND(모두 품목칸에 포함). 공백 제거·대소문자 무시 부분일치.
 *  - clients : 거래처 — 여러 개면 OR, 부분일치.
 * 종류끼리는 AND 이고, code/spec/text 는 '같은 행'에서 동시에 맞아야 한다.
 *
 * 2단계: ① MySQL 이 LONGTEXT 를 문자열로 1차 추림(REPLACE 공백 + UPPER + LIKE)
 *        ② 추린 것만 JSON 파싱해 행 단위로 정확히 확인. 새 테이블/백필 없이 동작.
 * 3년치(수만 건, 수십~백MB)도 ① 은 DB 풀스캔 한 번이라 1초 안팎. 느려지면 행 테이블로 교체.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StatementSearchService {

    private final JdbcTemplate jdbcTemplate;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 결과 상한(최신 저장순) — 너무 흔한 조건(예: '아크릴5T' 단독)이 화면을 덮지 않게. */
    public static final int MAX_ORDERS = 300;
    private static final int PREFILTER_LIMIT = 1500;

    private static final Pattern NUM = Pattern.compile("\\d+(?:\\.\\d+)?");
    private static final Pattern PAIR = Pattern.compile("(\\d+(?:\\.\\d+)?)\\s*(?:[*x×X]|\\s)\\s*(\\d+(?:\\.\\d+)?)");

    public record Match(Long orderId, List<Map<String, String>> rows) {}

    public record Result(List<Match> matches, boolean truncated) {}

    public Result search(List<String> codes, List<String> specs, List<String> texts,
                         List<String> clients, String requestType) {
        List<String> cs = clean(codes, true);
        List<String> ts = clean(texts, true);
        List<double[]> sps = new ArrayList<>();
        for (String s : clean(specs, false)) {
            double[] p = parseSpec(s);
            if (p != null) sps.add(p);
        }
        if (cs.isEmpty() && ts.isEmpty() && sps.isEmpty()) return new Result(List.of(), false);
        List<String> cl = clean(clients, false).stream().map(x -> x.toUpperCase(Locale.ROOT)).toList();

        // ① DB 1차 추림 — 전부 '포함' 조건이라 놓치는 건 없고, 정확 판정은 ② 에서.
        // 주문·거래처 조인 — 거래처/요청유형도 DB 에서 걸러야 '최신 300건' 상한이 다른 거래처로 차지 않는다.
        // (지시서가 정리된 명세서는 조인에서 자연히 빠짐)
        StringBuilder sql = new StringBuilder(
                "SELECT e.order_id, e.grid_json FROM autoquote_estimate e"
                        + " JOIN orders o ON o.id = e.order_id"
                        + " JOIN client_users cu ON cu.id = o.client_id WHERE 1=1");
        List<Object> args = new ArrayList<>();
        // UPPER — DB collation 이 대소문자 구분(_bin)이어도 동작하게.
        String squeezed = "UPPER(REPLACE(e.grid_json, ' ', ''))";
        if (requestType != null && !requestType.isBlank()) {
            sql.append(" AND o.request_type = ?");
            args.add(requestType.trim());
        }
        if (!cl.isEmpty()) {
            sql.append(" AND (");
            for (int i = 0; i < cl.size(); i++) {
                if (i > 0) sql.append(" OR ");
                sql.append("UPPER(cu.company_name) LIKE ? ESCAPE '!'");
                args.add("%" + like(cl.get(i)) + "%");
            }
            sql.append(")");
        }
        if (!cs.isEmpty()) {
            sql.append(" AND (");
            for (int i = 0; i < cs.size(); i++) {
                if (i > 0) sql.append(" OR ");
                sql.append(squeezed).append(" LIKE ? ESCAPE '!'");
                args.add("%" + like(cs.get(i)) + "%");
            }
            sql.append(")");
        }
        for (String t : ts) {
            sql.append(" AND ").append(squeezed).append(" LIKE ? ESCAPE '!'");
            args.add("%" + like(t) + "%");
        }
        if (!sps.isEmpty()) {
            sql.append(" AND (");
            for (int i = 0; i < sps.size(); i++) {
                if (i > 0) sql.append(" OR ");
                double[] sp = sps.get(i);
                sql.append("(e.grid_json LIKE ?");
                args.add("%" + fmt(sp[0]) + "%");
                if (!Double.isNaN(sp[1])) {
                    sql.append(" AND e.grid_json LIKE ?");
                    args.add("%" + fmt(sp[1]) + "%");
                }
                sql.append(")");
            }
            sql.append(")");
        }
        // 1차 추림 상한 — 너무 흔한 조건이 수천 건 JSON 을 메모리에 올리지 않게(MySQL JDBC 는 결과를 통째로 받음).
        sql.append(" ORDER BY e.saved_at DESC LIMIT ").append(PREFILTER_LIMIT);

        List<Match> out = new ArrayList<>();
        boolean[] truncated = {false};
        int[] read = {0};
        jdbcTemplate.query(sql.toString(), rs -> {
            read[0]++;
            if (out.size() >= MAX_ORDERS) {
                truncated[0] = true;
                return;
            }
            long orderId = rs.getLong("order_id");
            List<Map<String, String>> rows = matchRows(rs.getString("grid_json"), cs, ts, sps);
            if (!rows.isEmpty()) out.add(new Match(orderId, rows));
        }, args.toArray());
        if (read[0] >= PREFILTER_LIMIT) truncated[0] = true;
        return new Result(out, truncated[0]);
    }

    // ② 행 단위 정확 판정.
    static List<Map<String, String>> matchRows(String json, List<String> cs, List<String> ts, List<double[]> sps) {
        List<Map<String, String>> hits = new ArrayList<>();
        JsonNode grid;
        try {
            JsonNode root = MAPPER.readTree(json);
            grid = root.isArray() ? root : root.path("grid");
        } catch (Exception e) {
            return hits;
        }
        if (!grid.isArray()) return hits;
        for (JsonNode row : grid) {
            String rc = row.path("품목코드").asText("");
            String ri = row.path("품목").asText("");
            String rs = row.path("규격").asText("");
            if (!cs.isEmpty() && !cs.contains(norm(rc))) continue;
            String ni = norm(ri);
            if (!ts.stream().allMatch(ni::contains)) continue;
            if (!sps.isEmpty() && sps.stream().noneMatch(q -> specMatches(rs, q))) continue;
            Map<String, String> m = new LinkedHashMap<>();
            m.put("품목코드", rc);
            m.put("품목", ri);
            m.put("규격", rs);
            m.put("수량", row.path("수량").asText(""));
            m.put("단가", row.path("단가").asText(""));
            hits.add(m);
        }
        return hits;
    }

    private static List<String> clean(List<String> in, boolean normalize) {
        if (in == null) return List.of();
        return in.stream().filter(Objects::nonNull)
                .map(s -> normalize ? norm(s) : s.trim())
                .filter(s -> !s.isEmpty()).distinct().toList();
    }

    /** 검색 규격 → [a, b] (b=NaN 이면 숫자 하나). 숫자 없으면 null. */
    static double[] parseSpec(String s) {
        if (s == null) return null;
        String v = s.trim();
        if (v.isEmpty()) return null;
        Matcher p = PAIR.matcher(v);
        if (p.find()) return new double[]{Double.parseDouble(p.group(1)), Double.parseDouble(p.group(2))};
        Matcher n = NUM.matcher(v);
        if (n.find()) return new double[]{Double.parseDouble(n.group()), Double.NaN};
        return null;
    }

    /** 행 규격이 검색 규격과 같은지 — 쌍이면 순서 무관(가로·세로 뒤집힘 허용), 하나면 그 숫자 포함. */
    static boolean specMatches(String rowSpec, double[] q) {
        if (rowSpec == null || rowSpec.isBlank()) return false;
        if (Double.isNaN(q[1])) {
            Matcher n = NUM.matcher(rowSpec);
            while (n.find()) if (Double.parseDouble(n.group()) == q[0]) return true;
            return false;
        }
        Matcher p = PAIR.matcher(rowSpec);
        while (p.find()) {
            double a = Double.parseDouble(p.group(1));
            double b = Double.parseDouble(p.group(2));
            if ((a == q[0] && b == q[1]) || (a == q[1] && b == q[0])) return true;
        }
        return false;
    }

    /** 공백 제거 + 대문자. */
    static String norm(String s) {
        if (s == null) return "";
        return s.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    private static String like(String s) {
        return s.replace("!", "!!").replace("%", "!%").replace("_", "!_");
    }

    private static String fmt(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }
}
