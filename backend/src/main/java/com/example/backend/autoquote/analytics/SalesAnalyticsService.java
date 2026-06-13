package com.example.backend.autoquote.analytics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.example.backend.autoquote.predict.AutoQuoteDataSource;
import com.example.backend.entity.ClientUser;
import com.example.backend.repository.ClientUserRepository;
import org.springframework.stereotype.Service;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
    /**
     * 본체 자재(금속/판) — 키워드 우선순위 순(구체적인 것 먼저). <b>품목코드 + 품목명을 함께</b> 본다.
     * 숫자코드(200=본체제작/100-x=전원/0000x=LED모듈/500-2=도장/700=시트 …)는 자재코드가 아니라
     * 회계 분류코드라, 실제 자재는 품목란에 있다. 코드+품목을 합쳐 분류하면 '기타'가 17.9%→9.0%로 반감.
     * 본체 자재가 LED/전원보다 우선(예: '스텐후렘+LED'는 스텐 본체). 전기·시공·운임은 뒤에서 흡수.
     */
    private static final String[][] METALS = {
        {"골드스텐", "골드스텐"}, {"스텐", "스텐"}, {"갈바", "갈바"},
        {"투명아크릴", "아크릴"}, {"아크릴", "아크릴"}, {"포맥스", "포맥스"},
        {"고무스카시", "스카시"}, {"스카시", "스카시"},
        {"타카잔넬", "잔넬"}, {"잔넬", "잔넬"}, {"철판", "철판"},
    };
    /** 전원장치(SMPS) — HM-300W-12V / 유니온방수형 300W-12V / SMPS 등. */
    private static final Pattern POWER =
        Pattern.compile("(\\d+\\s*w[\\-\\s]*12v|hm[\\-\\s]*\\d+w|smps)", Pattern.CASE_INSENSITIVE);
    /** LED 광원/모듈 — KPL/KDL/APL(LED모듈 제품), 넘버원/로웬, 구백색/웜화이트 등. */
    private static final String[] LED_KW = {
        "kpl", "kdl", "apl", "넘버원", "로웬", "it-3s", "ss-w", "구백색", "구광각",
        "웜화이트", "미들라이트", "엘광등", "모듈", "형광",
    };

    private final AutoQuoteDataSource dataSource;
    private final ClientUserRepository clientRepo;
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicReference<SalesAnalytics> cache = new AtomicReference<>();

    public SalesAnalyticsService(AutoQuoteDataSource dataSource, ClientUserRepository clientRepo) {
        this.dataSource = dataSource;
        this.clientRepo = clientRepo;
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

    /** 캐시 비우기 — 거래처관리 별칭/명세서가 바뀐 뒤 다음 호출에서 재집계하도록. */
    public void clearCache() {
        cache.set(null);
    }

    private SalesAnalytics build() {
        Map<String, long[]> monthly = new TreeMap<>();   // ym -> [revenue, invoices]
        Map<Integer, long[]> yearly = new TreeMap<>();    // year -> [revenue, invoices]
        Map<String, long[]> clients = new LinkedHashMap<>(); // client -> [revenue, count]
        Map<String, String[]> clientYm = new LinkedHashMap<>(); // client -> [firstYm, lastYm]
        Map<String, Map<String, long[]>> clientMonthly = new LinkedHashMap<>(); // client -> ym -> [rev,count] (드릴다운·무버스)
        Map<String, Map<String, long[]>> clientItems = new LinkedHashMap<>();    // client -> label -> [rev,count] (드릴다운 주력품목)
        Map<String, long[]> items = new LinkedHashMap<>();   // itemCode -> [revenue, qty, count]
        Map<String, Long> materials = new LinkedHashMap<>(); // category -> revenue
        long[] seasonByMonth = new long[13];              // 1..12 합계(계절성)
        long totalRevenue = 0;
        int totalInvoices = 0;
        boolean any = false;

        // 거래처관리(ClientUser) 정식명으로 병합하는 정규화기 — 원본 명세서는 미변경, 집계 키만 정식명.
        Canonicalizer canon = Canonicalizer.from(safeClients());

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
                    String client = canon.canonical(norm(text(inv, "client")));
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
                        long[] cmv = clientMonthly.computeIfAbsent(client, k -> new TreeMap<>())
                                .computeIfAbsent(ym, k -> new long[2]);
                        cmv[0] += revenue;
                        cmv[1] += 1;
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
                            String item = norm(text(g, "item"));
                            // 품목 TOP — 숫자/빈칸 코드(200 등)는 무의미하므로 품목내용(괄호=현장명 제거)으로 표시·그룹.
                            // 두께(2T/3T)·사이즈(가로x세로) 토큰은 떼어 '아크릴2T/3T/8T'를 '아크릴'로 통합.
                            String label = groupItemLabel((!code.isBlank() && !isNumericCode(code)) ? code : stripParens(item));
                            if (!label.isBlank()) {
                                items.computeIfAbsent(label, k -> new long[3]);
                                items.get(label)[0] += lineRev;
                                items.get(label)[1] += (qty == 0 ? 1 : qty);
                                items.get(label)[2] += 1;
                                if (!client.isBlank()) {
                                    long[] civ = clientItems.computeIfAbsent(client, k -> new LinkedHashMap<>())
                                            .computeIfAbsent(label, k -> new long[2]);
                                    civ[0] += lineRev;
                                    civ[1] += 1;
                                }
                            }
                            String mat = material(code, item); // 코드+품목 함께
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
        Map<String, String> clientSeg = new HashMap<>();    // client -> 세그먼트(드릴다운 배지)
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
                clientSeg.put(name, seg);
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

        // ---- 올해 페이스(예상매출) + 거래처 무버스(YTD 동기간 증감) ----
        int curYear = 0;
        int curMonth = 0;
        if (refYm != null) {
            curYear = Integer.parseInt(refYm.substring(0, 4));
            curMonth = Integer.parseInt(refYm.substring(5, 7));
        }
        YearPace yearPace = yearPace(monthlyList, yearlyList, curYear, curMonth);
        Movers movers = movers(clientMonthly, curYear, curMonth);

        // ---- 거래처 드릴다운 상세 — 화면에 이름이 노출되는 거래처만(TOP/무버스/이탈위험) 한정 ----
        Set<String> need = new LinkedHashSet<>();
        topClients.forEach(c -> need.add(c.name()));
        movers.risers().forEach(m -> need.add(m.name()));
        movers.fallers().forEach(m -> need.add(m.name()));
        churnTop.forEach(c -> need.add(c.name()));
        Map<String, ClientDetail> clientDetails = new LinkedHashMap<>();
        for (String name : need) {
            long[] info = clients.get(name);
            if (info == null) {
                continue;
            }
            List<ClientMonth> cMonthly = clientMonthly.getOrDefault(name, Map.of()).entrySet().stream()
                    .map(en -> new ClientMonth(en.getKey(), en.getValue()[0], (int) en.getValue()[1]))
                    .sorted(Comparator.comparing(ClientMonth::ym)).toList();
            List<ClientItem> cItems = clientItems.getOrDefault(name, Map.of()).entrySet().stream()
                    .map(en -> new ClientItem(en.getKey(), en.getValue()[0], (int) en.getValue()[1]))
                    .sorted(Comparator.comparingLong(ClientItem::revenue).reversed()).limit(6).toList();
            String[] span = clientYm.get(name);
            String fYm = span == null ? null : span[0];
            String lYm = span == null ? null : span[1];
            int inactive = (refYm != null && lYm != null) ? monthsBetween(refYm, lYm) : 0;
            clientDetails.put(name, new ClientDetail(name, info[0], (int) info[1], fYm, lYm, inactive,
                    clientSeg.getOrDefault(name, ""), cMonthly, cItems));
        }

        Summary summary = summary(monthlyList, yearlyList, totalRevenue, totalInvoices, clients.size());
        return new SalesAnalytics(summary, monthlyList, yearlyList, topClients, topItems, materialList,
                seasonality, concentration, churnTop, newByYear, segments,
                yearPace, movers, clientDetails);
    }

    /**
     * 올해 예상매출(run-rate) — 올해 누적(YTD)을 작년 동기간 대비 성장률로 작년 전체에 투영.
     * 계절 타는 간판업이라 단순 ×12/월보다 작년 패턴 기반 투영이 정확. 작년 데이터 없으면 ×12/월 폴백.
     */
    private static YearPace yearPace(List<MonthPoint> monthly, List<YearPoint> yearly, int curYear, int curMonth) {
        long ytd = 0;
        long lastYtd = 0;
        for (MonthPoint mp : monthly) {
            int yy = Integer.parseInt(mp.ym().substring(0, 4));
            int mm = Integer.parseInt(mp.ym().substring(5, 7));
            if (mm <= curMonth) {
                if (yy == curYear) {
                    ytd += mp.revenue();
                } else if (yy == curYear - 1) {
                    lastYtd += mp.revenue();
                }
            }
        }
        long lastFull = 0;
        for (YearPoint yp : yearly) {
            if (yp.year() == curYear - 1) {
                lastFull = yp.revenue();
            }
        }
        long projected;
        Double projYoy = null;
        Double ytdYoy = null;
        if (lastYtd > 0 && lastFull > 0) {
            double growth = (double) ytd / lastYtd;
            projected = Math.round(lastFull * growth);
            ytdYoy = round1((ytd - lastYtd) * 100.0 / lastYtd);
            projYoy = round1((projected - lastFull) * 100.0 / lastFull);
        } else {
            projected = curMonth > 0 ? Math.round(ytd * 12.0 / curMonth) : ytd;
        }
        return new YearPace(curYear, curMonth, ytd, lastYtd, lastFull, projected, projYoy, ytdYoy);
    }

    /**
     * 거래처 무버스 — 올해 누적(1~curMonth) vs 작년 같은 기간의 거래처별 매출 증감.
     * 신규(작년 0)는 급상승, 끊긴 단골(올해 0)은 급감으로 자연히 잡힌다. 각 8곳.
     */
    private static Movers movers(Map<String, Map<String, long[]>> clientMonthly, int curYear, int curMonth) {
        if (curYear <= 0) {
            return new Movers("", List.of(), List.of());
        }
        List<Mover> all = new ArrayList<>();
        for (Map.Entry<String, Map<String, long[]>> e : clientMonthly.entrySet()) {
            long thisYtd = 0;
            long lastYtd = 0;
            for (Map.Entry<String, long[]> me : e.getValue().entrySet()) {
                int yy = Integer.parseInt(me.getKey().substring(0, 4));
                int mm = Integer.parseInt(me.getKey().substring(5, 7));
                if (mm <= curMonth) {
                    if (yy == curYear) {
                        thisYtd += me.getValue()[0];
                    } else if (yy == curYear - 1) {
                        lastYtd += me.getValue()[0];
                    }
                }
            }
            if (thisYtd == 0 && lastYtd == 0) {
                continue;
            }
            all.add(new Mover(e.getKey(), thisYtd, lastYtd, thisYtd - lastYtd));
        }
        List<Mover> risers = all.stream().filter(m -> m.delta() > 0)
                .sorted(Comparator.comparingLong(Mover::delta).reversed()).limit(8).toList();
        List<Mover> fallers = all.stream().filter(m -> m.delta() < 0)
                .sorted(Comparator.comparingLong(Mover::delta)).limit(8).toList();
        String basis = curYear + " 1~" + curMonth + "월 vs " + (curYear - 1) + " 1~" + curMonth + "월";
        return new Movers(basis, risers, fallers);
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

    /**
     * 코드+품목을 합쳐 자재/유형 카테고리 판정. 숫자코드는 자재코드가 아니라 회계 분류코드라
     * 실제 자재는 품목에 있음 → 코드+품목을 함께 본다. 본체 자재 우선, 전기·시공·운임·인쇄 흡수.
     */
    private static String material(String code, String item) {
        String xl = ((code == null ? "" : code) + " " + (item == null ? "" : item)).toLowerCase();
        for (String[] m : METALS) {
            if (xl.contains(m[0])) {
                return m[1];
            }
        }
        if (xl.contains("에칭") || xl.contains("시트")) {
            return "시트·에칭";
        }
        if (xl.contains("부식") || xl.contains("현판")) {
            return "부식·현판";
        }
        if (xl.contains("일체형")) {
            return "일체형";
        }
        if (xl.contains("네온")) {
            return "네온";
        }
        if (POWER.matcher(xl).find() || containsAny(xl, "안정기", "파워", "타이머", "조광기", "dimmer",
                "컨버터", "트랜스", "아답터", "방수형", "방수용")) {
            return "전원·제어";
        }
        if (containsAny(xl, LED_KW) || xl.contains("led") || xl.contains("엘이디") || xl.contains("광등")) {
            return "LED·광원";
        }
        if (xl.contains("후렘") || xl.contains("행잉")) {
            return "후렘·행잉";
        }
        if (xl.contains("도장") || xl.contains("파이프")) {
            return "도장·부자재";
        }
        if (containsAny(xl, "완조립", "조립비", "시공", "부착")) {
            return "조립·시공";
        }
        if (containsAny(xl, "운임", "퀵", "택배", "톤차", "화물", "다마스", "용달", "라보", "1톤", "5톤")) {
            return "운임·퀵";
        }
        if (xl.contains("할인")) {
            return "할인·조정";
        }
        if (containsAny(xl, "도안", "실사", "현도", "현수막", "배너", "마크", "인쇄")) {
            return "인쇄·도안";
        }
        return "기타";
    }

    private static boolean containsAny(String s, String... keys) {
        for (String k : keys) {
            if (s.contains(k)) {
                return true;
            }
        }
        return false;
    }

    /** 숫자(+하이픈)만으로 된 코드 = 무의미(200, 200-1, 100-0005 …). */
    private static boolean isNumericCode(String c) {
        return c != null && c.matches("[0-9][0-9\\-]*");
    }

    /** 품목에서 괄호(현장명/설명) 제거 — 200 같은 숫자코드의 표시 라벨용. */
    private static String stripParens(String s) {
        return s == null ? "" : s.replaceAll("\\([^)]*\\)", " ").replaceAll("\\s+", " ").trim();
    }

    /** 거래처 마스터 로드 — DB 오류여도 분석이 죽지 않게 빈 목록 폴백(이 경우 병합 없이 raw 표시). */
    private List<ClientUser> safeClients() {
        try {
            return clientRepo.findAll();
        } catch (Exception e) {
            return List.of();
        }
    }

    private static final Pattern P_THICK = Pattern.compile("\\d+(?:\\.\\d+)?\\s*[tT](?![a-zA-Z])");
    private static final Pattern P_DIM =
        Pattern.compile("\\d+\\s*[*xX×]\\s*\\d+(?:\\s*[*xX×]\\s*\\d+)?");

    /**
     * 품목 라벨 통합 — 두께(숫자+T)·사이즈(가로x세로) 토큰을 떼어 같은 품목으로 묶는다.
     * 예) '아크릴2T'·'아크릴 3T'·'아크릴8T'→'아크릴', '포맥스5T'→'포맥스', '고무스카시3T'→'고무스카시'.
     * 토큰을 떼면 빈 문자열이 되는(=토큰만 있던) 라벨은 원본을 유지.
     */
    static String groupItemLabel(String s) {
        if (s == null) {
            return "";
        }
        String x = P_DIM.matcher(s).replaceAll(" ");
        x = P_THICK.matcher(x).replaceAll(" ");
        x = x.replaceAll("\\s+", " ").trim();
        return x.isBlank() ? s.trim() : x;
    }

    // ---- 거래처 정식명 병합(표시 전용) -------------------------------------------------
    private static final Pattern P_PAREN = Pattern.compile("\\([^)]*\\)");
    private static final Pattern P_COMPANY_MARK =
        Pattern.compile("\\(주\\)|주식회사|\\(유\\)|유한회사|\\(사\\)|사단법인");
    private static final Pattern P_NON_NAME = Pattern.compile("[^0-9a-z가-힣]");

    /** NFC + 공백제거 + 소문자 — 정식명/별칭 정확일치 키. */
    private static String normKey(String s) {
        if (s == null) {
            return "";
        }
        String n = Normalizer.normalize(s, Normalizer.Form.NFC);
        StringBuilder sb = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); i++) {
            char ch = n.charAt(i);
            if (!Character.isWhitespace(ch)) {
                sb.append(ch);
            }
        }
        return sb.toString().toLowerCase();
    }

    /** (주)·주식회사·괄호(지점·구명칭) 제거 후 영숫자/한글만 — 핵심이름 키('(주)오디'·'미조사(제주)'→'오디'·'미조사'). */
    private static String coreKey(String s) {
        if (s == null) {
            return "";
        }
        String x = Normalizer.normalize(s, Normalizer.Form.NFC).toLowerCase();
        x = P_PAREN.matcher(x).replaceAll(" ");
        x = P_COMPANY_MARK.matcher(x).replaceAll(" ");
        return P_NON_NAME.matcher(x).replaceAll("");
    }

    private static List<String> splitAliases(String aliases) {
        if (aliases == null || aliases.isBlank()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String t : aliases.split("[,;\\n]")) {
            if (!t.isBlank()) {
                out.add(t.trim());
            }
        }
        return out;
    }

    /**
     * 명세서 raw client 문자열을 거래처관리(ClientUser) 정식명으로 매핑한다(표시 전용, 원본 미변경).
     * ① 정식명/별칭/폴더명 정확일치(공백·대소문자 무시) ② (주)·괄호 뗀 핵심이름 일치.
     * 핵심이름이 둘 이상 거래처에 겹치면(모호) 오병합 방지를 위해 매핑하지 않고 raw 유지.
     */
    private static final class Canonicalizer {
        private final Map<String, String> exact; // normKey -> companyName
        private final Map<String, String> core;   // coreKey -> companyName(모호 키 제외)

        private Canonicalizer(Map<String, String> exact, Map<String, String> core) {
            this.exact = exact;
            this.core = core;
        }

        static Canonicalizer from(List<ClientUser> clients) {
            Map<String, String> exact = new HashMap<>();
            Map<String, String> coreFirst = new HashMap<>(); // coreKey -> 최초 매핑
            Set<String> ambiguous = new HashSet<>();
            for (ClientUser c : clients) {
                String name = c.getCompanyName();
                if (name == null || name.isBlank()) {
                    continue;
                }
                String canonName = name.trim();
                List<String> aliases = splitAliases(c.getAliases());
                registerExact(exact, name, canonName);
                registerExact(exact, c.getNetworkFolderName(), canonName);
                for (String al : aliases) {
                    registerExact(exact, al, canonName);
                }
                List<String> srcs = new ArrayList<>();
                srcs.add(name);
                srcs.addAll(aliases);
                for (String src : srcs) {
                    String ck = coreKey(src);
                    if (ck.isBlank()) {
                        continue;
                    }
                    String prev = coreFirst.putIfAbsent(ck, canonName);
                    if (prev != null && !prev.equals(canonName)) {
                        ambiguous.add(ck); // 서로 다른 거래처가 같은 핵심이름 → 병합 금지
                    }
                }
            }
            Map<String, String> core = new HashMap<>();
            for (Map.Entry<String, String> e : coreFirst.entrySet()) {
                if (!ambiguous.contains(e.getKey())) {
                    core.put(e.getKey(), e.getValue());
                }
            }
            return new Canonicalizer(exact, core);
        }

        /** raw → 정식명. 매칭 없으면 raw(trim) 그대로. */
        String canonical(String raw) {
            if (raw == null || raw.isBlank()) {
                return raw == null ? "" : raw;
            }
            String hit = exact.get(normKey(raw));
            if (hit != null) {
                return hit;
            }
            String ck = coreKey(raw);
            if (!ck.isBlank()) {
                hit = core.get(ck);
                if (hit != null) {
                    return hit;
                }
            }
            return raw.trim();
        }

        private static void registerExact(Map<String, String> idx, String src, String canonName) {
            if (src == null || src.isBlank()) {
                return;
            }
            idx.putIfAbsent(normKey(src), canonName);
        }
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
                                 List<NewYear> newClientsByYear, List<Segment> segments,
                                 YearPace yearPace, Movers movers,
                                 Map<String, ClientDetail> clientDetails) {
    }

    /**
     * 올해 페이스 — 누적(YTD)·작년 동기간·작년 전체·예상 연매출(run-rate)·예상 YoY·누적 YoY.
     * 프론트의 목표 달성률 링은 클라이언트(localStorage 목표)에서 ytdRevenue/projected로 계산.
     */
    public record YearPace(int year, int throughMonth, long ytdRevenue, long lastYearYtd,
                           long lastYearFull, long projectedRevenue, Double projectedYoyPct,
                           Double ytdYoyPct) {
    }

    /** 거래처 무버스 — 비교 기준 라벨 + 급상승/급감 각 8곳. */
    public record Movers(String basis, List<Mover> risers, List<Mover> fallers) {
    }

    /** 무버 한 곳 — 올해 누적 vs 작년 동기간 + 증감액. */
    public record Mover(String name, long current, long previous, long delta) {
    }

    /** 거래처 드릴다운 상세 — 월별 추이 + 주력 품목 + 메타(세그먼트·마지막거래). */
    public record ClientDetail(String name, long totalRevenue, int orderCount, String firstYm,
                               String lastYm, int inactiveMonths, String segment,
                               List<ClientMonth> monthly, List<ClientItem> topItems) {
    }

    public record ClientMonth(String ym, long revenue, int count) {
    }

    public record ClientItem(String name, long revenue, int count) {
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
