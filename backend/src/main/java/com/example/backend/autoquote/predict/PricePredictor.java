package com.example.backend.autoquote.predict;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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

    /**
     * 견적 결과 한 줄. {@code price} 는 예측 단가(원). 매칭 실패 시 {@code price==null}.
     *
     * <p>JSON 직렬화 키는 spec 계약(snake_case, 9키)에 정확히 고정한다:
     * {@code item,size,qty,price,ref_invoice_idx,ref_file,src,score,reason}. 전역
     * PropertyNamingStrategy 대신 필드별 {@link JsonProperty} 로 <b>이 DTO 에만</b> 국소 적용
     * (다른 컨트롤러 응답에 영향 없음). 프론트(slice-11)가 이 키를 그대로 소비한다.
     */
    public record Prediction(
            @JsonProperty("item") String item,
            @JsonProperty("size") String size,
            @JsonProperty("qty") String qty,
            @JsonProperty("price") Integer price,
            @JsonProperty("ref_invoice_idx") Object refInvoiceIdx,
            @JsonProperty("ref_file") String refFile,
            @JsonProperty("src") String src,        // "이력" | "전체"
            @JsonProperty("score") Double score,
            @JsonProperty("reason") String reason,
            @JsonProperty("date") String date) {
    }

    /** 유사 품목코드 추천 1건 — 표기(code) + 코퍼스 내 건수(count). */
    public record CodeSuggestion(
            @JsonProperty("code") String code,
            @JsonProperty("count") int count) {
    }

    // ---- 공개 API -----------------------------------------------------------

    /** priced_index 를 읽어 인덱스를 만들 수 있으면 true(=예측 가능). 미프로비저닝이면 false. */
    public boolean isAvailable() {
        return index() != null;
    }

    /**
     * 단가 찾아보기 — 한 품목의 <b>품목코드</b> 기준 과거 단가 후보들을 우선순위로 나열.
     * ① 같은 거래처 + 같은 품목코드 → ② 타거래처 + 같은 품목코드(각 그룹 안에서 사이즈 근접도 순),
     * ③ 같은 품목코드 이력이 전혀 없으면 '관련'(품목 토큰 유사) 폴백. 사이즈만 비슷한 다른 품목코드는
     * 섞지 않는다. 가격은 과거 실거래 단가(스케일 안 함) — 사용자가 사이즈별 실값을 보고 고른다.
     * 코퍼스 미프로비저닝이면 {@code null}.
     */
    public List<Prediction> lookup(String client, Item it, int limit) {
        Index idx = index();
        if (idx == null) {
            return null;
        }
        int cap = Math.max(1, Math.min(limit, 50));
        String specBlob = specBlob(it);
        int[] qd = sizeDims(it.text(), specBlob); // 쿼리 가로·세로(높이형은 (h,h)). null=규격 없음
        String qtype = sizeType(it.text(), specBlob); // "height"(h:100/100) | "area"(가로*세로) | "none"
        String cl = cnorm(client);
        String codeNorm = ccode(it.material());

        List<Prediction> out = new ArrayList<>();
        // 품목코드와 품목을 함께 본다: 코드 버킷 ∪ 품목(item)에 검색 코드가 든 라인.
        // 숫자코드(200 등)는 자재가 품목에 적히므로, '갈바레이저타공' 검색 시 품목이 '갈바레이저타공'인
        // 200-코드 라인도 함께 잡힌다. (코드 단일귀속이 놓치는 부분일치를 품목 스캔이 보완)
        LinkedHashSet<Line> coded = new LinkedHashSet<>();
        if (!codeNorm.isBlank()) {
            List<Line> bucket = idx.byCode.get(codeNorm);
            if (bucket != null) {
                coded.addAll(bucket);
            }
            if (codeNorm.length() >= 2) {
                for (List<Line> lines : idx.byClient.values()) {
                    for (Line r : lines) {
                        if (itemHasCode(r.item, codeNorm)) {
                            coded.add(r);
                        }
                    }
                }
            }
        }
        if (!coded.isEmpty()) {
            List<Line> same = new ArrayList<>();
            List<Line> other = new ArrayList<>();
            for (Line r : coded) {
                (cl.equals(r.cl) ? same : other).add(r);
            }
            // 규격 타입(높이 vs 가로*세로)이 같은 것을 먼저, 그 안에서 가로·세로 차원 근접도 순.
            sortByTypeThenProximity(same, qd, qtype);
            sortByTypeThenProximity(other, qd, qtype);
            for (Line r : same) {
                out.add(toLookupPrediction(r, qd, "이력", it));
                if (out.size() >= cap) return out;
            }
            for (Line r : other) {
                out.add(toLookupPrediction(r, qd, "타거래처", it));
                if (out.size() >= cap) return out;
            }
            return out;
        }

        // 동일 품목코드 이력 없음 → '관련'(품목 토큰 자카드 ≥ 0.34) 폴백. 사이즈 근접도로 2차 정렬.
        Set<String> qtok = itoks(it.text(), specBlob);
        List<Scored> rel = new ArrayList<>();
        for (List<Line> lines : idx.byClient.values()) {
            for (Line r : lines) {
                double j = jaccard(qtok, r.itok);
                if (j >= JACCARD_MIN) {
                    rel.add(new Scored(r, j * 0.7 + dimProximity(qd, r.dims) * 0.3));
                }
            }
        }
        rel.sort((a, b) -> Double.compare(b.score, a.score));
        for (Scored s : rel) {
            out.add(toLookupPrediction(s.line, qd, "관련", it));
            if (out.size() >= cap) break;
        }
        return out;
    }

    /**
     * 입력 품목코드와 '비슷한' 코드들을 코퍼스에서 찾아 건수 많은 순으로 추천(같은 자재가 여러 표기·오타로
     * 흩어진 경우 함께 검색하라고). 유사도 = ① 정규화코드 부분포함(짧은 쪽 길이≥3) 0.95,
     * ② 아니면 글자 bigram Sørensen–Dice(≥0.4). 정확히 같은 코드는 제외. 미프로비저닝이면 빈 리스트.
     */
    public List<CodeSuggestion> similarCodes(String queryCode, int limit) {
        Index idx = index();
        if (idx == null) {
            return List.of();
        }
        String q = ccode(queryCode);
        if (q.isBlank()) {
            return List.of();
        }
        Set<String> qb = bigrams(q);
        int cap = Math.max(1, Math.min(limit, 20));
        record Cand(String code, int count, double sim) {
        }
        List<Cand> cands = new ArrayList<>();
        for (Map.Entry<String, List<Line>> e : idx.byCode.entrySet()) {
            String c = e.getKey();
            if (c.equals(q)) {
                continue; // 정확히 같은 코드는 이미 검색됨
            }
            double sim;
            int minLen = Math.min(q.length(), c.length());
            if (minLen >= 3 && (c.contains(q) || q.contains(c))) {
                sim = 0.95; // 부분포함(예: 갈바레이저타공 ⊂ 1.2T갈바레이저타공·갈바레이저타공후렘)
            } else {
                Set<String> cb = bigrams(c);
                int inter = 0;
                for (String b : qb) {
                    if (cb.contains(b)) {
                        inter++;
                    }
                }
                int denom = qb.size() + cb.size();
                sim = denom == 0 ? 0 : (2.0 * inter) / denom; // Sørensen–Dice
            }
            if (sim < 0.4) {
                continue;
            }
            cands.add(new Cand(displayCode(e.getValue()), e.getValue().size(), sim));
        }
        cands.sort((a, b) -> a.sim != b.sim ? Double.compare(b.sim, a.sim) : Integer.compare(b.count, a.count));
        List<CodeSuggestion> out = new ArrayList<>();
        for (Cand c : cands) {
            out.add(new CodeSuggestion(c.code, c.count));
            if (out.size() >= cap) {
                break;
            }
        }
        return out;
    }

    /** byCode 한 버킷의 대표 표기 — 가장 흔한 원본 code(정규화 전 철자). */
    private static String displayCode(List<Line> lines) {
        Map<String, Integer> freq = new LinkedHashMap<>();
        for (Line l : lines) {
            String c = l.code == null ? "" : l.code.trim();
            if (!c.isBlank()) {
                freq.merge(c, 1, Integer::sum);
            }
        }
        String best = null;
        int bn = -1;
        for (Map.Entry<String, Integer> e : freq.entrySet()) {
            if (e.getValue() > bn) {
                bn = e.getValue();
                best = e.getKey();
            }
        }
        return best != null ? best : "";
    }

    /** 글자 bigram 집합(유사도용). 길이 1이면 그 글자 자체를 단일 토큰으로. */
    private static Set<String> bigrams(String s) {
        Set<String> out = new HashSet<>();
        if (s == null || s.isEmpty()) {
            return out;
        }
        if (s.length() == 1) {
            out.add(s);
            return out;
        }
        for (int i = 0; i + 1 < s.length(); i++) {
            out.add(s.substring(i, i + 2));
        }
        return out;
    }

    private Prediction toLookupPrediction(Line r, int[] qd, String src, Item it) {
        double prox = dimProximity(qd, r.dims);
        String reason = buildLookupReason(r, src, prox);
        // 과거 실거래 단가(r.up)를 그대로 — 사용자가 사이즈별 실값을 비교해 고른다(스케일 안 함).
        return new Prediction(safe(r.item), n(r.spec), it.qty(), r.up, r.idx, r.file, src, round3(prox), reason, r.date());
    }

    private String buildLookupReason(Line r, String src, double prox) {
        String where = switch (src) {
            case "이력" -> "같은 거래처";
            case "타거래처" -> "타거래처";
            default -> "관련 품목";
        };
        StringBuilder sb = new StringBuilder();
        sb.append(where);
        if (r.code != null && !r.code.isBlank()) {
            sb.append(" · 품목코드 ").append(r.code.trim());
        }
        sb.append(" · ").append(safe(r.item));
        if (r.spec != null && !r.spec.isBlank()) {
            sb.append("(").append(r.spec.trim()).append(")");
        }
        sb.append(" · 단가 ").append(r.up).append("원");
        sb.append(" · 사이즈 근접 ").append(round3(prox));
        sb.append(" · 근거 idx=").append(String.valueOf(r.idx)).append(", file=").append(r.file);
        return sb.toString();
    }

    /**
     * 가로·세로 '차원' 근접도 0..1(클수록 비슷). 면적(곱) 하나만 보면 1200*400 와 692*692(같은 면적)
     * 를 동일 취급하는데, 가로·세로를 각각 비율로 보고 기하평균하면 '모양까지 비슷한' 것을 고른다.
     * 방향 무관(가로↔세로 뒤집힘 허용)으로 각 쌍을 정렬해 비교. 규격 없으면(둘 중 null) 0.5.
     */
    private static double dimProximity(int[] q, int[] r) {
        if (q == null || r == null) {
            return 0.5;
        }
        int qlo = Math.min(q[0], q[1]);
        int qhi = Math.max(q[0], q[1]);
        int rlo = Math.min(r[0], r[1]);
        int rhi = Math.max(r[0], r[1]);
        if (qlo <= 0 || qhi <= 0 || rlo <= 0 || rhi <= 0) {
            return 0.5;
        }
        double plo = (double) Math.min(qlo, rlo) / Math.max(qlo, rlo);
        double phi = (double) Math.min(qhi, rhi) / Math.max(qhi, rhi);
        return Math.sqrt(plo * phi); // 기하평균 — 한 변만 비슷하면 점수가 크게 안 오름(모양 보존)
    }

    /** 규격에서 가로·세로 추출: AxB→(A,B), h:NNN/단일→(N,N), 없으면 null. */
    static int[] sizeDims(String item, String spec) {
        String blob = ((item == null ? "" : item) + " " + (spec == null ? "" : spec)).toLowerCase();
        Matcher a = P_AREA.matcher(blob);
        if (a.find()) {
            return new int[] {Integer.parseInt(a.group(1)), Integer.parseInt(a.group(2))};
        }
        Matcher h = P_HEIGHT.matcher(blob);
        if (h.find()) {
            int v = Integer.parseInt(h.group(1));
            return new int[] {v, v};
        }
        Matcher any = P_ANY.matcher(blob);
        if (any.find()) {
            int v = Integer.parseInt(any.group(1));
            return new int[] {v, v};
        }
        return null;
    }

    /** 같은 규격 타입(높이/가로*세로)을 먼저, 그 안에서 가로·세로 차원 근접도 순. */
    private static void sortByTypeThenProximity(List<Line> lines, int[] qd, String qtype) {
        boolean typed = !"none".equals(qtype);
        lines.sort((a, b) -> {
            if (typed) {
                boolean am = qtype.equals(sizeType(a.item, a.spec));
                boolean bm = qtype.equals(sizeType(b.item, b.spec));
                if (am != bm) {
                    return am ? -1 : 1; // 같은 타입을 앞으로
                }
            }
            return Double.compare(dimProximity(qd, b.dims), dimProximity(qd, a.dims));
        });
    }

    /** 규격 타입: 곱하기(가로*세로[*z])면 "area", h:NNN/단일 숫자면 "height", 숫자 없으면 "none". */
    static String sizeType(String item, String spec) {
        String blob = ((item == null ? "" : item) + " " + (spec == null ? "" : spec)).toLowerCase();
        if (P_AREA.matcher(blob).find()) {
            return "area";
        }
        if (P_HEIGHT.matcher(blob).find() || P_ANY.matcher(blob).find()) {
            return "height";
        }
        return "none";
    }

    private static String specBlob(Item it) {
        return blank(it.material()) ? n(it.size()) : it.material() + " " + n(it.size());
    }

    /** 품목코드 정규화(프론트 normCode 와 동일 규칙: 공백/슬래시 제거 + 라틴 대문자). 한글은 불변. */
    static String ccode(String s) {
        if (s == null) {
            return "";
        }
        return s.trim().replaceAll("[\\s/]", "").toUpperCase();
    }

    /** 품목(item)에 검색 코드가 포함되는지 — 코드와 동일 정규화(공백/슬래시 제거+대문자)로 부분일치. */
    private static boolean itemHasCode(String item, String codeNorm) {
        if (item == null || item.isBlank()) {
            return false;
        }
        return item.replaceAll("[\\s/]", "").toUpperCase().contains(codeNorm);
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
        Long qsz = sizeVal(text, specBlob);
        String cl = cnorm(client);

        Scored best = bestIn(idx.byClient.get(cl), qtok, qsz);
        String src = "이력";
        if (best == null) {
            best = bestIn(idx.byItem.get(inorm(text)), qtok, qsz);
            src = "전체";
        }
        if (best == null) {
            return new Prediction(text, it.size(), it.qty(), null, null, null, null, null,
                    "매칭되는 과거 단가를 찾지 못했습니다(동일품목 자카드 0.34 미만).", null);
        }

        Line r = best.line;
        int basePrice = r.up;          // toLine 에서 up>0 보장(0/음수 라인은 인덱스에서 배제됨).
        int price = basePrice;
        double factor = 1.0;
        boolean scaled = false;
        // 사이즈 보정은 요청·이력 사이즈가 둘 다 양수일 때만. 하나라도 null/≤0 이면 보정 생략(factor=1).
        // (5자리 치수의 v*v 가 long 이라 오버플로는 없지만, 0/음수 입력에서 sqrt 가 NaN 이 되는 것을 막는다.)
        if (qsz != null && qsz > 0 && r.sz != null && r.sz > 0) {
            factor = Math.sqrt((double) qsz / r.sz);
            factor = Math.max(0.5, Math.min(2.0, factor));
            int scaledPrice = (int) Math.round(basePrice * factor);
            // factor 는 [0.5,2.0] 유한값이고 basePrice>0 이라 정상 경로에선 항상 >0 이지만,
            // 어떤 경로로든 0/음수가 나오면 보정 실패로 보고 ref.up(=basePrice)을 그대로 쓴다.
            price = scaledPrice > 0 ? scaledPrice : basePrice;
            scaled = true;
        }

        String reason = buildReason(src, r, basePrice, factor, price, scaled, best.score, qsz);
        return new Prediction(text, it.size(), it.qty(), price, r.idx, r.file, src,
                round3(best.score), reason, r.date());
    }

    private String buildReason(String src, Line r, int basePrice, double factor, int price,
                               boolean scaled, double score, Long qsz) {
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
    private Scored bestIn(List<Line> cands, Set<String> qtok, Long qsz) {
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
                long lo = Math.min(qsz, r.sz);
                long hi = Math.max(qsz, r.sz);
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
        Map<String, List<Line>> byCode = new LinkedHashMap<>();
        JsonNode bc = root.get("by_client");
        if (bc == null || !bc.isObject()) {
            return new Index(byClient, byItem, byCode);
        }
        List<Line> all = new ArrayList<>();
        var fields = bc.fields();
        while (fields.hasNext()) {
            var e = fields.next();
            String clientNorm = e.getKey();
            List<Line> lines = new ArrayList<>();
            for (JsonNode ln : e.getValue()) {
                Line line = toLine(ln, clientNorm);
                if (line == null) {
                    continue;
                }
                lines.add(line);
                all.add(line);
            }
            byClient.put(clientNorm, lines);
        }
        // 자재코드 어휘 빌드 후, byCode 를 resolveCode(코드+품목)로 키잉. 숫자/빈칸 코드(전체 39%)는
        // 품목에 적힌 실제 자재타입으로 귀속 → "200/갈바레이저타공" 도 갈바레이저타공으로 검색됨.
        List<String> vocab = buildVocab(all);
        for (Line line : all) {
            byItem.computeIfAbsent(inorm(line.item), k -> new ArrayList<>()).add(line);
            String rc = resolveCode(line.code, line.item, vocab);
            if (!rc.isBlank()) {
                byCode.computeIfAbsent(rc, k -> new ArrayList<>()).add(line);
            }
        }
        return new Index(byClient, byItem, byCode);
    }

    private static final java.util.regex.Pattern P_NUMCODE = java.util.regex.Pattern.compile("[0-9][0-9\\-]*");
    private static final String[] MAT_KW = {
        "갈바", "아크릴", "스텐", "포맥스", "스카시", "잔넬", "골드스텐", "고무", "투명", "에폭시",
        "일체형", "채널", "후광", "측광", "전광", "전후광", "비조명", "도시락", "오사이", "절곡",
        "헤어라인", "타공", "레이저", "레이져", "에칭", "먹통", "후렘", "포리싱", "조각", "금경",
        "은경", "무광", "백색", "검정", "적색", "알마이트", "철판", "시트", "네온", "캡",
        "행잉", "용접", "돌출", "부식", "현판", "파이프",
    };

    private static boolean isNumericCode(String c) {
        return c != null && P_NUMCODE.matcher(c).matches();
    }

    private static boolean hasMaterialKw(String s) {
        if (s == null) {
            return false;
        }
        for (String k : MAT_KW) {
            if (s.contains(k)) {
                return true;
            }
        }
        return false;
    }

    /** 자재코드 어휘 — 숫자아님 + 자재키워드 포함 코드. 긴 것 우선(부분일치 정확도). */
    private static List<String> buildVocab(List<Line> all) {
        Set<String> set = new HashSet<>();
        for (Line l : all) {
            String c = l.code == null ? "" : l.code.trim();
            if (!c.isBlank() && !isNumericCode(c) && hasMaterialKw(c)) {
                set.add(c);
            }
        }
        List<String> v = new ArrayList<>(set);
        v.sort((a, b) -> b.length() - a.length());
        return v;
    }

    /**
     * 효과적 코드(검색·그룹 키): 코드가 의미있는 자재코드면 그대로(정규화), 숫자/빈칸/비자재 코드면
     * 품목(괄호=현장명 제거)에서 알려진 자재코드를 부분일치로 찾아 귀속. 못 찾으면 원 코드.
     */
    private static String resolveCode(String code, String item, List<String> vocab) {
        String c = code == null ? "" : code.trim();
        if (!c.isBlank() && !isNumericCode(c) && hasMaterialKw(c)) {
            return ccode(c);
        }
        String it = item == null ? "" : item.replaceAll("\\([^)]*\\)", " ");
        for (String v : vocab) {
            if (it.contains(v)) {
                return ccode(v);
            }
        }
        return ccode(c);
    }

    private Line toLine(JsonNode ln, String clientNorm) {
        if (!ln.hasNonNull("up")) {
            return null;
        }
        int up = ln.get("up").asInt();
        if (up <= 0) {
            return null;
        }
        String item = text(ln, "item");
        String spec = text(ln, "spec");
        String code = text(ln, "code");
        Long sz = ln.hasNonNull("sz") ? ln.get("sz").asLong() : null;
        Object idx = ln.hasNonNull("idx")
                ? (ln.get("idx").isNumber() ? (Object) ln.get("idx").asInt() : ln.get("idx").asText())
                : null;
        String file = text(ln, "file");
        String date = text(ln, "date");
        return new Line(idx, file, item, spec, up, sz, itoks(item, spec), code, clientNorm, sizeDims(item, spec), date);
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

    /**
     * 대표 사이즈 스칼라: AxB 면적 → A*B; h:NNN → NNN^2; 단일 숫자 → NNN^2; 없으면 null.
     *
     * <p>곱/제곱은 반드시 {@code long} 으로 한다. 5자리 치수(예 50000)의 {@code v*v}=2.5e9 는
     * {@code int} 범위(2.147e9)를 넘어 오버플로로 음수가 되는데, 그러면 하류 {@code sqrt(neg)} 가
     * NaN → {@code price=0} 이 되어 spec 의 {@code price>0} 계약을 깬다. Python 원본은 임의정밀도라
     * 오버플로가 없으므로 {@code long} 으로 동일 동작을 보장한다.
     */
    static Long sizeVal(String item, String spec) {
        String blob = ((item == null ? "" : item) + " " + (spec == null ? "" : spec)).toLowerCase();
        Matcher area = P_AREA.matcher(blob);
        if (area.find()) {
            return (long) Integer.parseInt(area.group(1)) * Integer.parseInt(area.group(2));
        }
        Matcher h = P_HEIGHT.matcher(blob);
        if (h.find()) {
            long v = Integer.parseInt(h.group(1));
            return v * v;
        }
        Matcher any = P_ANY.matcher(blob);
        if (any.find()) {
            long v = Integer.parseInt(any.group(1));
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

    private record Line(Object idx, String file, String item, String spec, int up, Long sz,
                        Set<String> itok, String code, String cl, int[] dims, String date) {
    }

    private record Scored(Line line, double score) {
    }

    private record Index(Map<String, List<Line>> byClient, Map<String, List<Line>> byItem,
                         Map<String, List<Line>> byCode) {
    }
}
