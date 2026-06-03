package com.example.backend.autoquote.predict;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 자동견적 가격예측기. {@code build_learn_corpus.py} 의 정규화/토큰화/사이즈/예측 로직을 그대로 포팅.
 *
 * <p>학습코퍼스 {@code priced_index.json}({@code {by_client:{client_norm:[line...]}}})을
 * {@link AutoQuoteDataSource} 로 읽어 두 인덱스로 만든다:
 * <ol>
 *   <li>{@code byClient} — 거래처 정규화키 → 가격라인. 견적 tier ①(같은 거래처 이력).</li>
 *   <li>{@code byItem} — 품목 정규화키(inorm) → 가격라인. tier ②(전체 동일품목 폴백).</li>
 * </ol>
 *
 * <p>예측: ① 같은 거래처 동일품목(품목 토큰 자카드 ≥ 0.34) 중 사이즈 최근접 → ② 없으면 전체
 * 동일품목. 가격 = {@code ref.up × clamp(sqrt(qsz/ref.sz), 0.5, 2.0)}.
 */
@Component
public class PricePredictor {

    private static final String PRICED_INDEX_NAME = "priced_index.json";
    private static final double JACCARD_MIN = 0.34;

    private final AutoQuoteDataSource dataSource;
    private final ObjectMapper json = new ObjectMapper();

    /** 한 번 성공적으로 로드된 인덱스를 캐시(코퍼스 캐시와 동일 정책 — 실패는 캐시하지 않음). */
    private final AtomicReference<Index> indexRef = new AtomicReference<>();

    public PricePredictor(AutoQuoteDataSource dataSource) {
        this.dataSource = dataSource;
    }

    // ---- 입력/출력 계약 -----------------------------------------------------

    /** 견적 요청 한 줄: 품목 텍스트 + 재질 + 사이즈 + 수량. */
    public record Item(String text, String material, String size, String qty) {
    }

    /** 견적 결과 한 줄. {@code price} 는 예측 단가(원). 매칭 실패 시 {@code price==null}. */
    public record Prediction(
            String item,
            String size,
            String qty,
            Integer price,
            Object refInvoiceIdx,
            String refFile,
            String src,        // "이력" | "전체"
            Double score,
            String reason) {
    }

    // ---- 공개 API -----------------------------------------------------------

    /** priced_index 를 읽어 인덱스를 만들 수 있으면 true(=예측 가능). 미프로비저닝이면 false. */
    public boolean isAvailable() {
        return index() != null;
    }

    /** 여러 견적 라인을 예측. 코퍼스 미프로비저닝이면 {@code null}(호출부가 503 처리). */
    public List<Prediction> predict(String client, List<Item> items) {
        Index idx = index();
        if (idx == null) {
            return null;
        }
        List<Prediction> out = new ArrayList<>();
        for (Item it : items) {
            out.add(predictOne(idx, client, it));
        }
        return out;
    }

    private Prediction predictOne(Index idx, String client, Item it) {
        String text = it.text();
        // 재질+사이즈를 spec 처럼 합쳐 토큰/사이즈 파싱(숫자는 토큰에서 제외되므로 사이즈만 영향).
        String specBlob = blank(it.material()) ? n(it.size()) : it.material() + " " + n(it.size());
        Set<String> qtok = itoks(text, specBlob);
        Integer qsz = sizeVal(text, specBlob);
        String cl = cnorm(client);

        Scored best = bestIn(idx.byClient.get(cl), qtok, qsz);
        String src = "이력";
        if (best == null) {
            best = bestIn(idx.byItem.get(inorm(text)), qtok, qsz);
            src = "전체";
        }
        if (best == null) {
            return new Prediction(text, it.size(), it.qty(), null, null, null, null, null,
                    "매칭되는 과거 단가를 찾지 못했습니다(동일품목 자카드 0.34 미만).");
        }

        Line r = best.line;
        int basePrice = r.up;
        int price = basePrice;
        double factor = 1.0;
        boolean scaled = false;
        if (qsz != null && r.sz != null && r.sz > 0) {
            factor = Math.sqrt((double) qsz / r.sz);
            factor = Math.max(0.5, Math.min(2.0, factor));
            price = (int) Math.round(basePrice * factor);
            scaled = true;
        }

        String reason = buildReason(src, r, basePrice, factor, price, scaled, best.score, qsz);
        return new Prediction(text, it.size(), it.qty(), price, r.idx, r.file, src,
                round3(best.score), reason);
    }

    private String buildReason(String src, Line r, int basePrice, double factor, int price,
                               boolean scaled, double score, Integer qsz) {
        String where = "이력".equals(src)
                ? "같은 거래처 이력에서"
                : "전체 거래처 이력에서";
        StringBuilder sb = new StringBuilder();
        sb.append(where).append(" 동일품목 '").append(safe(r.item)).append("'");
        if (r.spec != null && !r.spec.isBlank()) {
            sb.append("(").append(r.spec.trim()).append(")");
        }
        sb.append(" 매칭(품목 토큰 자카드 ").append(round3(score)).append(").");
        sb.append(" 기준단가 ").append(basePrice).append("원");
        if (scaled) {
            sb.append(" × 사이즈보정 ").append(round3(factor)).append("배")
              .append("(요청 ").append(qsz).append(" / 이력 ").append(r.sz).append(")")
              .append(" = ").append(price).append("원");
        } else {
            sb.append(" 적용(사이즈 정보 부족으로 보정 없음).");
        }
        sb.append(" 근거 명세서 idx=").append(String.valueOf(r.idx)).append(", file=").append(r.file).append(".");
        return sb.toString();
    }

    /** 후보군에서 자카드≥0.34 인 것 중 (자카드 0.7 + 사이즈근접 0.3) 최고점을 고른다. */
    private Scored bestIn(List<Line> cands, Set<String> qtok, Integer qsz) {
        if (cands == null) {
            return null;
        }
        Line best = null;
        double bestSc = -1;
        for (Line r : cands) {
            double j = jaccard(qtok, r.itok);
            if (j < JACCARD_MIN) {
                continue;
            }
            double ratio;
            if (qsz != null && r.sz != null) {
                int lo = Math.min(qsz, r.sz);
                int hi = Math.max(qsz, r.sz);
                ratio = hi == 0 ? 0.5 : (double) lo / hi;
            } else {
                ratio = 0.5;
            }
            double sc = j * 0.7 + ratio * 0.3;
            if (sc > bestSc) {
                bestSc = sc;
                best = r;
            }
        }
        return best == null ? null : new Scored(best, bestSc);
    }

    // ---- 인덱스 로드/구축 ---------------------------------------------------

    private Index index() {
        Index existing = indexRef.get();
        if (existing != null) {
            return existing;
        }
        byte[] bytes = dataSource.load(PRICED_INDEX_NAME);
        if (bytes == null) {
            return null; // 미프로비저닝 — 캐시하지 않음(나중에 채워질 수 있음).
        }
        Index built;
        try {
            built = build(json.readTree(bytes));
        } catch (Exception e) {
            return null; // 손상된 JSON 도 graceful 처리.
        }
        indexRef.compareAndSet(null, built);
        return indexRef.get();
    }

    private Index build(JsonNode root) {
        Map<String, List<Line>> byClient = new LinkedHashMap<>();
        Map<String, List<Line>> byItem = new LinkedHashMap<>();
        JsonNode bc = root.get("by_client");
        if (bc == null || !bc.isObject()) {
            return new Index(byClient, byItem);
        }
        var fields = bc.fields();
        while (fields.hasNext()) {
            var e = fields.next();
            String clientNorm = e.getKey();
            List<Line> lines = new ArrayList<>();
            for (JsonNode ln : e.getValue()) {
                Line line = toLine(ln);
                if (line == null) {
                    continue;
                }
                lines.add(line);
                byItem.computeIfAbsent(inorm(line.item), k -> new ArrayList<>()).add(line);
            }
            byClient.put(clientNorm, lines);
        }
        return new Index(byClient, byItem);
    }

    private Line toLine(JsonNode ln) {
        if (!ln.hasNonNull("up")) {
            return null;
        }
        int up = ln.get("up").asInt();
        if (up <= 0) {
            return null;
        }
        String item = text(ln, "item");
        String spec = text(ln, "spec");
        Integer sz = ln.hasNonNull("sz") ? ln.get("sz").asInt() : null;
        Object idx = ln.hasNonNull("idx")
                ? (ln.get("idx").isNumber() ? (Object) ln.get("idx").asInt() : ln.get("idx").asText())
                : null;
        String file = text(ln, "file");
        return new Line(idx, file, item, spec, up, sz, itoks(item, spec));
    }

    // ---- 포팅된 정규화/토큰/사이즈 함수 (build_learn_corpus.py) -------------

    private static final Pattern P_COMPANY = Pattern.compile("\\(주\\)|주식회사");
    private static final Pattern P_NON_CKD = Pattern.compile("[^0-9a-z가-힣]");
    private static final Pattern P_DIGITS = Pattern.compile("[0-9]+");
    private static final Pattern P_NON_LETTER = Pattern.compile("[^a-z가-힣]");
    private static final Pattern P_TOKEN = Pattern.compile("[a-z가-힣]{2,}");
    private static final Pattern P_AREA = Pattern.compile("(\\d{2,5})\\s*[*x×]\\s*(\\d{2,5})");
    private static final Pattern P_HEIGHT = Pattern.compile("h\\s*[:：]?\\s*(\\d{2,4})");
    private static final Pattern P_ANY = Pattern.compile("(\\d{2,5})");

    /** 거래처 정규화: 소문자 → (주)/주식회사 제거 → 영숫자/한글만. */
    static String cnorm(String s) {
        String x = (s == null ? "" : s).toLowerCase();
        x = P_COMPANY.matcher(x).replaceAll("");
        return P_NON_CKD.matcher(x).replaceAll("");
    }

    /** 품목 정규화: 소문자 → 숫자(사이즈) 제거 → 영문/한글만(품목 종류만 남김). */
    static String inorm(String s) {
        String x = (s == null ? "" : s).toLowerCase();
        x = P_DIGITS.matcher(x).replaceAll("");
        return P_NON_LETTER.matcher(x).replaceAll("");
    }

    /** 품목 토큰 집합: item+spec 소문자에서 길이≥2 영문/한글 토큰. */
    static Set<String> itoks(String item, String spec) {
        String s = ((item == null ? "" : item) + " " + (spec == null ? "" : spec)).toLowerCase();
        Set<String> out = new HashSet<>();
        Matcher m = P_TOKEN.matcher(s);
        while (m.find()) {
            out.add(m.group());
        }
        return out;
    }

    /** 대표 사이즈 스칼라: AxB 면적 → A*B; h:NNN → NNN^2; 단일 숫자 → NNN^2; 없으면 null. */
    static Integer sizeVal(String item, String spec) {
        String blob = ((item == null ? "" : item) + " " + (spec == null ? "" : spec)).toLowerCase();
        Matcher area = P_AREA.matcher(blob);
        if (area.find()) {
            return Integer.parseInt(area.group(1)) * Integer.parseInt(area.group(2));
        }
        Matcher h = P_HEIGHT.matcher(blob);
        if (h.find()) {
            int v = Integer.parseInt(h.group(1));
            return v * v;
        }
        Matcher any = P_ANY.matcher(blob);
        if (any.find()) {
            int v = Integer.parseInt(any.group(1));
            return v * v;
        }
        return null;
    }

    private static double jaccard(Set<String> a, Set<String> b) {
        if (a.isEmpty() && b.isEmpty()) {
            return 0.0;
        }
        int inter = 0;
        for (String t : a) {
            if (b.contains(t)) {
                inter++;
            }
        }
        int union = a.size() + b.size() - inter;
        return inter / (double) Math.max(1, union);
    }

    // ---- 작은 헬퍼 ----------------------------------------------------------

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static String n(String s) {
        return s == null ? "" : s;
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    // ---- 내부 자료구조 ------------------------------------------------------

    private record Line(Object idx, String file, String item, String spec, int up, Integer sz,
                        Set<String> itok) {
    }

    private record Scored(Line line, double score) {
    }

    private record Index(Map<String, List<Line>> byClient, Map<String, List<Line>> byItem) {
    }
}
