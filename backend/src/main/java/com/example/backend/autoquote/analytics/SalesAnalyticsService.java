package com.example.backend.autoquote.analytics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.example.backend.autoquote.predict.AutoQuoteDataSource;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 매출분석 — 상세 명세서({@code easyform_*_*.json})를 집계해 대시보드용 통계를 만든다.
 * 데이터는 {@link AutoQuoteDataSource}(파일시스템→비공개 R2)에서 읽으며, 기밀이라 응답에는
 * 가공된 집계치(월/연/거래처/품목/자재 합계)만 담는다. 4년치 8만 줄 파싱이 무거우므로 결과를 캐시.
 *
 * <p>매출 = 명세서의 공급가액({@code supply_total}, VAT 제외). 없으면 {@code total}→라인합 폴백.
 */
@Service
public class SalesAnalyticsService {

    private static final Pattern NUM = Pattern.compile("-?\\d[\\d,]*");
    /** 자재 카테고리 — 키워드 우선순위 순(구체적인 것 먼저). 품목코드/품목명에 포함되면 그 카테고리. */
    private static final String[][] MATERIALS = {
        {"골드스텐", "골드스텐"}, {"스텐", "스텐"}, {"갈바", "갈바"},
        {"투명아크릴", "아크릴"}, {"아크릴", "아크릴"}, {"포맥스", "포맥스"},
        {"고무스카시", "스카시"}, {"스카시", "스카시"},
        {"잔넬", "잔넬"}, {"네온", "네온"}, {"철판", "철판"},
        {"에칭", "시트·에칭"}, {"시트", "시트·에칭"}, {"일체형", "일체형"},
    };

    private final AutoQuoteDataSource dataSource;
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicReference<SalesAnalytics> cache = new AtomicReference<>();

    public SalesAnalyticsService(AutoQuoteDataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** 집계 결과(캐시). 명세서 자산 미프로비저닝이면 {@code null}(호출부 503). */
    public SalesAnalytics analytics() {
        SalesAnalytics cached = cache.get();
        if (cached != null) {
            return cached;
        }
        SalesAnalytics built = build();
        if (built != null) {
            cache.set(built);
        }
        return built;
    }

    private SalesAnalytics build() {
        Map<String, long[]> monthly = new TreeMap<>();   // ym -> [revenue, invoices]
        Map<Integer, long[]> yearly = new TreeMap<>();    // year -> [revenue, invoices]
        Map<String, long[]> clients = new LinkedHashMap<>(); // client -> [revenue, count]
        Map<String, String[]> clientYm = new LinkedHashMap<>(); // client -> [firstYm, lastYm]
        Map<String, long[]> items = new LinkedHashMap<>();   // itemCode -> [revenue, qty, count]
        Map<String, Long> materials = new LinkedHashMap<>(); // category -> revenue
        long[] seasonByMonth = new long[13];              // 1..12 합계(계절성)
        long totalRevenue = 0;
        int totalInvoices = 0;
        boolean any = false;

        for (int year = 2022; year <= 2031; year++) {
            for (String type : new String[] {"corp", "personal"}) {
                byte[] bytes = dataSource.load("easyform_" + year + "_" + type + ".json");
                if (bytes == null) {
                    continue;
                }
                any = true;
                JsonNode root;
                try {
                    root = json.readTree(bytes);
                } catch (Exception e) {
                    continue;
                }
                JsonNode invs = root.get("invoices");
                if (invs == null || !invs.isArray()) {
                    continue;
                }
                for (JsonNode inv : invs) {
                    String date = text(inv, "date");
                    String ym = ym(date);
                    if (ym == null) {
                        continue;
                    }
                    int y = Integer.parseInt(ym.substring(0, 4));
                    int mo = Integer.parseInt(ym.substring(5, 7));
                    long revenue = invoiceRevenue(inv);
                    if (revenue <= 0) {
                        continue;
                    }
                    totalRevenue += revenue;
                    totalInvoices++;
                    monthly.computeIfAbsent(ym, k -> new long[2]);
                    monthly.get(ym)[0] += revenue;
                    monthly.get(ym)[1] += 1;
                    yearly.computeIfAbsent(y, k -> new long[2]);
                    yearly.get(y)[0] += revenue;
                    yearly.get(y)[1] += 1;
                    if (mo >= 1 && mo <= 12) {
                        seasonByMonth[mo] += revenue;
                    }
                    String client = norm(text(inv, "client"));
                    if (!client.isBlank()) {
                        clients.computeIfAbsent(client, k -> new long[2]);
                        clients.get(client)[0] += revenue;
                        clients.get(client)[1] += 1;
                        String[] span = clientYm.computeIfAbsent(client, k -> new String[] {ym, ym});
                        if (ym.compareTo(span[0]) < 0) {
                            span[0] = ym;
                        }
                        if (ym.compareTo(span[1]) > 0) {
                            span[1] = ym;
                        }
                    }
                    // 라인(품목/자재) 집계 — 라인 매출 = 수량 × 단가.
                    JsonNode grid = inv.get("grid");
                    if (grid != null && grid.isArray()) {
                        for (JsonNode g : grid) {
                            long qty = Math.max(0, num(text(g, "qty")));
                            long up = num(text(g, "unit_price"));
                            if (up <= 0) {
                                continue;
                            }
                            long lineRev = (qty == 0 ? 1 : qty) * up;
                            String code = norm(text(g, "item_code"));
                            String label = code.isBlank() ? norm(text(g, "item")) : code;
                            if (!label.isBlank()) {
                                items.computeIfAbsent(label, k -> new long[3]);
                                items.get(label)[0] += lineRev;
                                items.get(label)[1] += (qty == 0 ? 1 : qty);
                                items.get(label)[2] += 1;
                            }
                            String mat = material(code.isBlank() ? text(g, "item") : code);
                            materials.merge(mat, lineRev, Long::sum);
                        }
                    }
                }
            }
        }
        if (!any) {
            return null; // 명세서 자산 미프로비저닝
        }

        List<MonthPoint> monthlyList = new ArrayList<>();
        for (Map.Entry<String, long[]> e : monthly.entrySet()) {
            monthlyList.add(new MonthPoint(e.getKey(), e.getValue()[0], (int) e.getValue()[1]));
        }
        List<YearPoint> yearlyList = new ArrayList<>();
        for (Map.Entry<Integer, long[]> e : yearly.entrySet()) {
            yearlyList.add(new YearPoint(e.getKey(), e.getValue()[0], (int) e.getValue()[1]));
        }
        List<NameRevenue> topClients = clients.entrySet().stream()
                .map(e -> new NameRevenue(e.getKey(), e.getValue()[0], (int) e.getValue()[1]))
                .sorted(Comparator.comparingLong(NameRevenue::revenue).reversed())
                .limit(15).toList();
        List<ItemStat> topItems = items.entrySet().stream()
                .map(e -> new ItemStat(e.getKey(), e.getValue()[0], e.getValue()[1], (int) e.getValue()[2]))
                .sorted(Comparator.comparingLong(ItemStat::revenue).reversed())
                .limit(15).toList();
        List<NameRevenue> materialList = materials.entrySet().stream()
                .map(e -> new NameRevenue(e.getKey(), e.getValue(), 0))
                .sorted(Comparator.comparingLong(NameRevenue::revenue).reversed())
                .toList();
        List<MonthAvg> seasonality = new ArrayList<>();
        for (int m = 1; m <= 12; m++) {
            seasonality.add(new MonthAvg(m, seasonByMonth[m]));
        }

        // ---- 리서치 반영: 거래처 집중도 / 이탈위험(silent churn) / 신규 / RFM 세그먼트 ----
        String refYm = monthlyList.isEmpty() ? null : monthlyList.get(monthlyList.size() - 1).ym();
        List<long[]> revSorted = clients.values().stream()
                .sorted((a, b) -> Long.compare(b[0], a[0])).toList();
        Concentration concentration = concentration(revSorted, totalRevenue, clients.size());

        long[] revAll = clients.values().stream().mapToLong(a -> a[0]).sorted().toArray();
        long p75 = revAll.length == 0 ? 0 : revAll[Math.min(revAll.length - 1, (int) (revAll.length * 0.75))];
        List<ChurnClient> churn = new ArrayList<>();
        Map<Integer, Integer> newByYearMap = new TreeMap<>();
        Map<String, long[]> segAgg = new LinkedHashMap<>(); // seg -> [clients, revenue]
        if (refYm != null) {
            for (Map.Entry<String, long[]> e : clients.entrySet()) {
                String name = e.getKey();
                long rev = e.getValue()[0];
                int cnt = (int) e.getValue()[1];
                String[] span = clientYm.get(name);
                if (span == null) {
                    continue;
                }
                int recency = monthsBetween(refYm, span[1]); // 마지막 거래 후 경과 개월
                int sinceFirst = monthsBetween(refYm, span[0]);
                newByYearMap.merge(Integer.parseInt(span[0].substring(0, 4)), 1, Integer::sum);
                String seg;
                if (recency >= 6) {
                    seg = "이탈위험·휴면";
                } else if (sinceFirst <= 6 && cnt <= 2) {
                    seg = "신규";
                } else if (rev >= p75) {
                    seg = "우수(VIP)";
                } else {
                    seg = "일반(활성)";
                }
                segAgg.computeIfAbsent(seg, k -> new long[2]);
                segAgg.get(seg)[0] += 1;
                segAgg.get(seg)[1] += rev;
                if (cnt >= 3) {
                    int avgGap = Math.max(1, monthsBetween(span[1], span[0]) / (cnt - 1));
                    if (recency >= Math.max(4, avgGap * 2)) {
                        churn.add(new ChurnClient(name, rev, span[1], recency, cnt));
                    }
                }
            }
        }
        churn.sort((a, b) -> Long.compare(b.revenue(), a.revenue()));
        List<ChurnClient> churnTop = new ArrayList<>(churn.subList(0, Math.min(12, churn.size())));
        List<NewYear> newByYear = newByYearMap.entrySet().stream()
                .map(e -> new NewYear(e.getKey(), e.getValue())).toList();
        List<Segment> segments = segAgg.entrySet().stream()
                .map(e -> new Segment(e.getKey(), (int) e.getValue()[0], e.getValue()[1]))
                .sorted((a, b) -> Long.compare(b.revenue(), a.revenue())).toList();

        Summary summary = summary(monthlyList, yearlyList, totalRevenue, totalInvoices, clients.size());
        return new SalesAnalytics(summary, monthlyList, yearlyList, topClients, topItems, materialList,
                seasonality, concentration, churnTop, newByYear, segments);
    }

    private static Concentration concentration(List<long[]> revSorted, long total, int n) {
        if (revSorted.isEmpty() || total <= 0) {
            return new Concentration(0, 0, 0, 0, 0, 0);
        }
        long t1 = 0;
        long t5 = 0;
        long t10 = 0;
        double hhi = 0;
        long cum = 0;
        int pareto = 0;
        boolean done = false;
        for (int i = 0; i < revSorted.size(); i++) {
            long rev = revSorted.get(i)[0];
            if (i < 1) {
                t1 += rev;
            }
            if (i < 5) {
                t5 += rev;
            }
            if (i < 10) {
                t10 += rev;
            }
            double share = (double) rev / total * 100.0;
            hhi += share * share;
            if (!done) {
                cum += rev;
                pareto++;
                if (cum >= total * 0.8) {
                    done = true;
                }
            }
        }
        return new Concentration(round1((double) t1 / total * 100), round1((double) t5 / total * 100),
                round1((double) t10 / total * 100), (int) Math.round(hhi),
                pareto, round1((double) pareto / n * 100));
    }

    /** 'YYYY.MM' 두 시점의 개월 차(later - earlier), 음수면 0. */
    private static int monthsBetween(String laterYm, String earlierYm) {
        return Math.max(0, ymOrd(laterYm) - ymOrd(earlierYm));
    }

    private static int ymOrd(String ym) {
        return Integer.parseInt(ym.substring(0, 4)) * 12 + Integer.parseInt(ym.substring(5, 7));
    }

    private Summary summary(List<MonthPoint> monthly, List<YearPoint> yearly,
                            long totalRevenue, int totalInvoices, int clientCount) {
        String firstYm = monthly.isEmpty() ? null : monthly.get(0).ym();
        String lastYm = monthly.isEmpty() ? null : monthly.get(monthly.size() - 1).ym();
        long latestRev = monthly.isEmpty() ? 0 : monthly.get(monthly.size() - 1).revenue();
        Double momPct = null;
        if (monthly.size() >= 2) {
            long prev = monthly.get(monthly.size() - 2).revenue();
            if (prev > 0) {
                momPct = round1((latestRev - prev) * 100.0 / prev);
            }
        }
        int latestYear = yearly.isEmpty() ? 0 : yearly.get(yearly.size() - 1).year();
        long latestYearRev = yearly.isEmpty() ? 0 : yearly.get(yearly.size() - 1).revenue();
        Double yoyPct = null;
        if (yearly.size() >= 2) {
            long prev = yearly.get(yearly.size() - 2).revenue();
            if (prev > 0) {
                yoyPct = round1((latestYearRev - prev) * 100.0 / prev);
            }
        }
        long avg = totalInvoices == 0 ? 0 : totalRevenue / totalInvoices;
        return new Summary(totalRevenue, totalInvoices, avg, firstYm, lastYm,
                lastYm, latestRev, momPct, latestYear, latestYearRev, yoyPct, clientCount);
    }

    private long invoiceRevenue(JsonNode inv) {
        long st = num(text(inv, "supply_total"));
        if (st > 0) {
            return st;
        }
        long tot = num(text(inv, "total"));
        if (tot > 0) {
            return Math.round(tot / 1.1); // total(VAT포함) → 공급가액 근사
        }
        long sum = 0;
        JsonNode grid = inv.get("grid");
        if (grid != null && grid.isArray()) {
            for (JsonNode g : grid) {
                long qty = Math.max(1, num(text(g, "qty")));
                long up = num(text(g, "unit_price"));
                if (up > 0) {
                    sum += qty * up;
                }
            }
        }
        return sum;
    }

    private static String material(String s) {
        String x = s == null ? "" : s;
        for (String[] m : MATERIALS) {
            if (x.contains(m[0])) {
                return m[1];
            }
        }
        return "기타";
    }

    /** 'YYYY.MM.DD' / 'YYYY-MM-..' → 'YYYY.MM'. 파싱 실패면 null. */
    private static String ym(String date) {
        if (date == null) {
            return null;
        }
        Matcher m = Pattern.compile("(\\d{4})\\D+(\\d{1,2})").matcher(date);
        if (!m.find()) {
            return null;
        }
        int mo = Integer.parseInt(m.group(2));
        if (mo < 1 || mo > 12) {
            return null;
        }
        return m.group(1) + "." + (mo < 10 ? "0" + mo : String.valueOf(mo));
    }

    private static long num(String s) {
        if (s == null) {
            return 0;
        }
        Matcher m = NUM.matcher(s);
        return m.find() ? Long.parseLong(m.group().replace(",", "")) : 0;
    }

    private static String norm(String s) {
        return s == null ? "" : s.trim();
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    // ---- 응답 DTO (전역 네이밍 설정 없음 → 기본 camelCase 직렬화: totalRevenue, topClients …) ----
    public record SalesAnalytics(Summary summary, List<MonthPoint> monthly, List<YearPoint> yearly,
                                 List<NameRevenue> topClients, List<ItemStat> topItems,
                                 List<NameRevenue> materials, List<MonthAvg> seasonality,
                                 Concentration concentration, List<ChurnClient> churnRisk,
                                 List<NewYear> newClientsByYear, List<Segment> segments) {
    }

    /** 거래처 집중도 — 상위 N개 매출 점유율 + HHI + 파레토(매출 80% 차지 거래처 수/비율). */
    public record Concentration(double top1Pct, double top5Pct, double top10Pct, int hhi,
                                int pareto80Count, double pareto80Pct) {
    }

    /** 이탈 위험 거래처 — 마지막 거래월/경과 개월/거래 횟수. */
    public record ChurnClient(String name, long revenue, String lastYm, int inactiveMonths, int orders) {
    }

    /** 연도별 신규 거래처 수(그 해 첫 거래). */
    public record NewYear(int year, int newClients) {
    }

    /** RFM 세그먼트 — 거래처 수 + 매출. */
    public record Segment(String name, int clients, long revenue) {
    }

    public record Summary(long totalRevenue, int totalInvoices, long avgInvoice, String firstYm, String lastYm,
                          String latestYm, long latestRevenue, Double momPct,
                          int latestYear, long latestYearRevenue, Double yoyPct, int clientCount) {
    }

    public record MonthPoint(String ym, long revenue, int invoices) {
    }

    public record YearPoint(int year, long revenue, int invoices) {
    }

    public record NameRevenue(String name, long revenue, int count) {
    }

    public record ItemStat(String name, long revenue, long qty, int count) {
    }

    public record MonthAvg(int month, long revenue) {
    }
}
