package com.example.backend.autoquote.analytics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
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
 * 매출분석 — <b>홈페이지에서 작성해 이지폼 입력까지 끝낸 명세서만</b> 모아 대시보드 통계를 만든다
 * (2026-11-24 사용자 결정: 옛 이지폼 추출 파일은 지저분해서 매출분석에서 뺌. 파일 자체는 단가찾아보기·
 * 자동견적이 계속 쓰므로 지우지 않음). 30분마다 자동 재집계, 화면 [지금 업데이트]로 즉시 재집계.
 *
 * <p>매출 = 명세서 합계(total = 단가×수량 합, VAT 제외). 없으면 라인합 폴백.
 */
@Service
public class SalesAnalyticsService {

    /** 자동 재집계 주기(분). */
    public static final int REFRESH_MINUTES = 30;

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

    private final JdbcTemplate jdbc;
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicReference<SalesAnalytics> cache = new AtomicReference<>();

    public SalesAnalyticsService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 집계 결과 — 30분마다 다시 만든 캐시를 준다. 아직 없으면(서버 막 켜짐) 지금 만든다. */
    public SalesAnalytics analytics() {
        SalesAnalytics c = cache.get();
        return c != null ? c : rebuild();
    }

    /** 지금 바로 다시 집계(화면 [지금 업데이트] 버튼). */
    public synchronized SalesAnalytics rebuild() {
        SalesAnalytics built = build(LocalDate.now(), LocalDateTime.now());
        cache.set(built);
        return built;
    }

    /** 30분마다 자동 집계 — 서버 켜지고 1분 뒤 첫 집계. */
    @Scheduled(initialDelay = 60_000, fixedDelay = REFRESH_MINUTES * 60_000L)
    public void scheduledRebuild() {
        try {
            rebuild();
        } catch (Exception e) {
            // 다음 주기에 다시 시도 — 이전 캐시는 그대로 둔다.
        }
    }

    /** 한 명세서(집계용으로 단순화). */
    private record Inv(Long orderId, String orderNumber, LocalDate date, String client, long revenue,
                       List<Line> lines) {
    }

    private record Line(String code, String item, long qty, long unitPrice) {
    }

    /**
     * 홈페이지 명세서(autoquote_estimate) 중 <b>이지폼 입력까지 끝난(완료) 것만</b> — 임시저장은 아직 매출 아님.
     * 날짜 = 이지폼 발행일(easyformSync.efKey) → 없으면 이지폼 입력 날짜. 거래처 = 주문의 거래처(거래처관리 정식명).
     * 합친 명세서의 '딸린 주문'(sharedWith 포인터)은 대표 주문 1장만 센다. 휴지통 주문은 뺀다.
     */
    private List<Inv> load() {
        List<Inv> out = new ArrayList<>();
        jdbc.query("SELECT e.order_id, o.order_number, e.grid_json, e.easyform_uploaded_at, cu.company_name "
                        + "FROM autoquote_estimate e JOIN orders o ON o.id = e.order_id "
                        + "LEFT JOIN client_users cu ON cu.id = o.client_id "
                        + "WHERE e.easyform_uploaded_at IS NOT NULL AND o.deleted_at IS NULL",
                rs -> {
                    JsonNode doc;
                    try {
                        doc = json.readTree(rs.getString(3));
                    } catch (Exception ex) {
                        return;
                    }
                    if (doc == null || !doc.isObject() || doc.hasNonNull("sharedWith")) {
                        return;
                    }
                    LocalDate d = null;
                    String[] parts = doc.path("easyformSync").path("efKey").asText("").split("\\|");
                    if (parts.length >= 2) {
                        d = parseDate(parts[1]);
                    }
                    if (d == null && rs.getTimestamp(4) != null) {
                        d = rs.getTimestamp(4).toLocalDateTime().toLocalDate();
                    }
                    if (d == null) {
                        return;
                    }
                    List<Line> lines = new ArrayList<>();
                    long sum = 0;
                    JsonNode grid = doc.path("grid");
                    if (grid.isArray()) {
                        for (JsonNode g : grid) {
                            long qty = num(g.path("수량").asText(""));
                            long up = num(g.path("단가").asText(""));
                            lines.add(new Line(g.path("품목코드").asText("").trim(), g.path("품목").asText("").trim(),
                                    qty, up));
                            if (up > 0) {
                                sum += Math.max(1, qty) * up;
                            }
                        }
                    }
                    long rev = num(doc.path("total").asText(""));
                    if (rev <= 0) {
                        rev = sum;
                    }
                    if (rev <= 0) {
                        return;
                    }
                    String client = rs.getString(5);
                    out.add(new Inv(rs.getLong(1), rs.getString(2), d,
                            client == null || client.isBlank() ? "(거래처 없음)" : client.trim(), rev, lines));
                });
        return out;
    }

    private SalesAnalytics build(LocalDate today, LocalDateTime now) {
        List<Inv> all = load();
        all.sort(Comparator.comparing(Inv::date).thenComparing(Inv::orderId));

        long total = 0;
        Map<LocalDate, long[]> byDay = new TreeMap<>();
        Map<String, long[]> byMonth = new TreeMap<>();
        Map<String, long[]> clientAll = new LinkedHashMap<>();
        Map<String, long[]> clientMonth = new LinkedHashMap<>();
        Map<String, LocalDate[]> clientSpan = new HashMap<>();
        Map<String, Map<String, long[]>> clientMonthly = new HashMap<>();
        Map<String, Map<String, long[]>> clientItems = new HashMap<>();
        Map<String, long[]> items = new LinkedHashMap<>();
        Map<String, Long> materials = new LinkedHashMap<>();
        String thisYm = ym(today);

        for (Inv inv : all) {
            total += inv.revenue();
            add(byDay.computeIfAbsent(inv.date(), k -> new long[2]), inv.revenue());
            String ym = ym(inv.date());
            add(byMonth.computeIfAbsent(ym, k -> new long[2]), inv.revenue());
            String c = inv.client();
            add(clientAll.computeIfAbsent(c, k -> new long[2]), inv.revenue());
            if (ym.equals(thisYm)) {
                add(clientMonth.computeIfAbsent(c, k -> new long[2]), inv.revenue());
            }
            LocalDate[] span = clientSpan.computeIfAbsent(c, k -> new LocalDate[] {inv.date(), inv.date()});
            if (inv.date().isBefore(span[0])) {
                span[0] = inv.date();
            }
            if (inv.date().isAfter(span[1])) {
                span[1] = inv.date();
            }
            add(clientMonthly.computeIfAbsent(c, k -> new TreeMap<>()).computeIfAbsent(ym, k -> new long[2]),
                    inv.revenue());
            for (Line g : inv.lines()) {
                if (g.unitPrice() <= 0) {
                    continue;
                }
                long q = g.qty() <= 0 ? 1 : g.qty();
                long lineRev = q * g.unitPrice();
                String label = groupItemLabel((!g.code().isBlank() && !isNumericCode(g.code()))
                        ? g.code() : stripParens(g.item()));
                if (!label.isBlank()) {
                    long[] it = items.computeIfAbsent(label, k -> new long[3]);
                    it[0] += lineRev;
                    it[1] += q;
                    it[2] += 1;
                    add(clientItems.computeIfAbsent(c, k -> new LinkedHashMap<>())
                            .computeIfAbsent(label, k -> new long[2]), lineRev);
                }
                materials.merge(material(g.code(), g.item()), lineRev, Long::sum);
            }
        }

        // ---- 이번 달 / 지난달 같은 기간 / 오늘 / 이번 주 ----
        LocalDate monthStart = today.withDayOfMonth(1);
        LocalDate prevStart = monthStart.minusMonths(1);
        LocalDate prevSameEnd = prevStart.plusDays(Math.min(today.getDayOfMonth(), prevStart.lengthOfMonth()) - 1);
        LocalDate weekStart = today.with(DayOfWeek.MONDAY);
        long thisMonth = 0, thisMonthCnt = 0, prevSame = 0, prevFull = 0, todayRev = 0, todayCnt = 0, weekRev = 0;
        for (Map.Entry<LocalDate, long[]> e : byDay.entrySet()) {
            LocalDate d = e.getKey();
            long r = e.getValue()[0];
            if (!d.isBefore(monthStart) && !d.isAfter(today)) {
                thisMonth += r;
                thisMonthCnt += e.getValue()[1];
            }
            if (!d.isBefore(prevStart) && d.isBefore(monthStart)) {
                prevFull += r;
                if (!d.isAfter(prevSameEnd)) {
                    prevSame += r;
                }
            }
            if (d.equals(today)) {
                todayRev += r;
                todayCnt += e.getValue()[1];
            }
            if (!d.isBefore(weekStart) && !d.isAfter(today)) {
                weekRev += r;
            }
        }
        Double vsPrevPct = prevSame > 0 ? round1((thisMonth - prevSame) * 100.0 / prevSame) : null;
        ThisMonth tm = new ThisMonth(thisYm, today.getDayOfMonth(), thisMonth, (int) thisMonthCnt,
                prevSame, prevFull, vsPrevPct, todayRev, (int) todayCnt, weekRev);

        // ---- 일별(최근 60일, 0원 날 채움) / 주별(월요일 시작, 첫 주~이번 주) / 월별 ----
        List<Point> daily = new ArrayList<>();
        for (LocalDate d = today.minusDays(59); !d.isAfter(today); d = d.plusDays(1)) {
            long[] v = byDay.getOrDefault(d, new long[2]);
            daily.add(new Point(d.toString(), v[0], (int) v[1]));
        }
        List<Point> weekly = new ArrayList<>();
        if (!byDay.isEmpty()) {
            LocalDate first = ((TreeMap<LocalDate, long[]>) byDay).firstKey().with(DayOfWeek.MONDAY);
            for (LocalDate w = first; !w.isAfter(weekStart); w = w.plusWeeks(1)) {
                long r = 0;
                int n = 0;
                for (long[] v : ((TreeMap<LocalDate, long[]>) byDay).subMap(w, w.plusWeeks(1)).values()) {
                    r += v[0];
                    n += (int) v[1];
                }
                weekly.add(new Point(w.toString(), r, n));
            }
        }
        List<Point> monthly = new ArrayList<>();
        if (!byMonth.isEmpty()) {
            YearMonth m0 = YearMonth.parse(((TreeMap<String, long[]>) byMonth).firstKey());
            for (YearMonth m = m0; !m.isAfter(YearMonth.from(today)); m = m.plusMonths(1)) {
                long[] v = byMonth.getOrDefault(m.toString(), new long[2]);
                monthly.add(new Point(m.toString(), v[0], (int) v[1]));
            }
        }

        List<NameRevenue> topClients = rank(clientAll, 15);
        List<NameRevenue> topClientsMonth = rank(clientMonth, 15);
        List<ItemStat> topItems = items.entrySet().stream()
                .map(e -> new ItemStat(e.getKey(), e.getValue()[0], e.getValue()[1], (int) e.getValue()[2]))
                .sorted(Comparator.comparingLong(ItemStat::revenue).reversed()).limit(15).toList();
        List<NameRevenue> materialList = materials.entrySet().stream()
                .map(e -> new NameRevenue(e.getKey(), e.getValue(), 0))
                .sorted(Comparator.comparingLong(NameRevenue::revenue).reversed()).toList();

        // ---- 거래처 상세(화면에 이름이 뜨는 거래처만) ----
        Set<String> need = new LinkedHashSet<>();
        topClients.forEach(c -> need.add(c.name()));
        topClientsMonth.forEach(c -> need.add(c.name()));
        Map<String, ClientDetail> details = new LinkedHashMap<>();
        for (String name : need) {
            long[] info = clientAll.get(name);
            LocalDate[] span = clientSpan.get(name);
            List<ClientMonth> cm = clientMonthly.getOrDefault(name, Map.of()).entrySet().stream()
                    .map(e -> new ClientMonth(e.getKey(), e.getValue()[0], (int) e.getValue()[1])).toList();
            List<ClientItem> ci = clientItems.getOrDefault(name, Map.of()).entrySet().stream()
                    .map(e -> new ClientItem(e.getKey(), e.getValue()[0], (int) e.getValue()[1]))
                    .sorted(Comparator.comparingLong(ClientItem::revenue).reversed()).limit(6).toList();
            details.put(name, new ClientDetail(name, info[0], (int) info[1], span[0].toString(), span[1].toString(),
                    cm, ci));
        }

        // ---- 최근 완료 명세서 20건(새로 올라온 게 제대로 잡혔는지 눈으로 확인용) ----
        List<RecentInvoice> recent = new ArrayList<>();
        for (int i = all.size() - 1; i >= 0 && recent.size() < 20; i--) {
            Inv v = all.get(i);
            recent.add(new RecentInvoice(v.orderId(), v.orderNumber(), v.date().toString(), v.client(), v.revenue()));
        }

        Summary summary = new Summary(total, all.size(), all.isEmpty() ? 0 : total / all.size(), clientAll.size(),
                all.isEmpty() ? null : all.get(0).date().toString(),
                all.isEmpty() ? null : all.get(all.size() - 1).date().toString());
        return new SalesAnalytics(now.withNano(0).toString(), REFRESH_MINUTES, summary, tm, daily, weekly, monthly,
                topClients, topClientsMonth, topItems, materialList, details, recent);
    }

    private static void add(long[] acc, long revenue) {
        acc[0] += revenue;
        acc[1] += 1;
    }

    private static List<NameRevenue> rank(Map<String, long[]> m, int n) {
        return m.entrySet().stream()
                .map(e -> new NameRevenue(e.getKey(), e.getValue()[0], (int) e.getValue()[1]))
                .sorted(Comparator.comparingLong(NameRevenue::revenue).reversed()).limit(n).toList();
    }

    private static String ym(LocalDate d) {
        return YearMonth.from(d).toString(); // 2026-11
    }

    private static final Pattern P_YMD = Pattern.compile("(\\d{4})\\D+(\\d{1,2})\\D+(\\d{1,2})");

    /** '2026.11.24' / '2026-11-24' / '2026/11/24' → 날짜. 실패면 null. */
    private static LocalDate parseDate(String s) {
        if (s == null) {
            return null;
        }
        Matcher m = P_YMD.matcher(s);
        if (!m.find()) {
            return null;
        }
        try {
            return LocalDate.of(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)),
                    Integer.parseInt(m.group(3)));
        } catch (Exception e) {
            return null;
        }
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

    private static long num(String s) {
        if (s == null) {
            return 0;
        }
        Matcher m = NUM.matcher(s);
        return m.find() ? Long.parseLong(m.group().replace(",", "")) : 0;
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    // ---- 응답 DTO (기본 camelCase 직렬화) ----
    public record SalesAnalytics(String updatedAt, int refreshMinutes, Summary summary, ThisMonth thisMonth,
                                 List<Point> daily, List<Point> weekly, List<Point> monthly,
                                 List<NameRevenue> topClients, List<NameRevenue> topClientsMonth,
                                 List<ItemStat> topItems, List<NameRevenue> materials,
                                 Map<String, ClientDetail> clientDetails, List<RecentInvoice> recent) {
    }

    /** 전체 기간 요약 — firstDate/lastDate = 첫·마지막 명세서 발행일(데이터 없으면 null). */
    public record Summary(long totalRevenue, int invoices, long avgInvoice, int clientCount,
                          String firstDate, String lastDate) {
    }

    /** 이번 달(1일~오늘) vs 지난달 같은 기간(1일~같은 날) + 지난달 전체 + 오늘 + 이번 주(월요일~). */
    public record ThisMonth(String ym, int throughDay, long revenue, int invoices, long prevSamePeriod,
                            long prevMonthFull, Double vsPrevPct, long todayRevenue, int todayInvoices,
                            long weekRevenue) {
    }

    /** key = 날짜(2026-11-24) / 주 시작 월요일 / 월(2026-11). */
    public record Point(String key, long revenue, int invoices) {
    }

    public record NameRevenue(String name, long revenue, int count) {
    }

    public record ItemStat(String name, long revenue, long qty, int count) {
    }

    public record ClientDetail(String name, long totalRevenue, int invoices, String firstDate, String lastDate,
                               List<ClientMonth> monthly, List<ClientItem> topItems) {
    }

    public record ClientMonth(String ym, long revenue, int count) {
    }

    public record ClientItem(String name, long revenue, int count) {
    }

    public record RecentInvoice(Long orderId, String orderNumber, String date, String client, long revenue) {
    }
}
