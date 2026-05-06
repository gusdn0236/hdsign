import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import WorksheetThumbnail from "../../components/common/WorksheetThumbnail.jsx";
import {
  ALL_WORKERS,
  getWorkersForSlots,
  getWorkerHue,
} from "../../data/workers.js";
import "./WorkStatus.css";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

// 발주관리와 동일한 납기 컬러 시스템 — overdue/today/tomorrow 만 컬러, 나머지는 텍스트.
function getDueBadge(dateStr) {
  if (!dateStr) return null;
  const ymd = String(dateStr).split("T")[0];
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dt.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { kind: "overdue", text: `${-diff}일 지남` };
  if (diff === 0) return { kind: "today", text: "오늘" };
  if (diff === 1) return { kind: "tomorrow", text: "내일" };
  return null;
}

function formatDueShort(dateStr) {
  if (!dateStr) return "-";
  const ymd = String(dateStr).split("T")[0];
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return ymd;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(m)}-${pad(d)} (${WEEKDAY_KO[dt.getDay()]})`;
}

// 완료 시각 — 오늘은 'HH:MM', 어제는 '어제 HH:MM', 그 외엔 'M/D HH:MM'.
function formatCompletedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return hm;
  if (diffDays === 1) return `어제 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 직원 컬러 dot — workers.js 의 hue 해시로 안정적인 색.
function WorkerDot({ name }) {
  const hue = getWorkerHue(name);
  const style = {
    background: `hsl(${hue}, 65%, 48%)`,
    boxShadow: `0 0 0 2px hsl(${hue}, 65%, 88%)`,
  };
  return <span className="ws-worker-dot" style={style} aria-hidden="true" />;
}

// 기간 토글 — 오늘/이번주/이번달/전체. completedAt 기준으로 필터.
function periodMatches(iso, period) {
  if (period === "all") return true;
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return d.getTime() >= start.getTime();
  }
  if (period === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay()); // 일요일 00:00
    start.setHours(0, 0, 0, 0);
    return d.getTime() >= start.getTime();
  }
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return d.getTime() >= start.getTime();
  }
  return true;
}

const PERIOD_TABS = [
  { key: "today", label: "오늘" },
  { key: "week", label: "이번주" },
  { key: "month", label: "이번달" },
  { key: "all", label: "전체" },
];

export default function WorkStatus() {
  const { token } = useAuth();
  // entries 의 한 row = 한 직원의 한 worksheet 완료 기록. 같은 worksheet 을 김진섭+김명수가
  // 각자 처리하면 두 entry 가 만들어진다(per-worker independent). 한 worksheet 카드 1개에 여러
  // 직원을 묶어 표시하는 대신 직원별로 펼쳐서 직원별 처리량 통계가 정확해진다.
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("today");
  const [workerFilter, setWorkerFilter] = useState("ALL");

  const loadOrders = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("작업 목록을 불러오지 못했습니다.");
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      // 발주(ORDER) 의 workerCompletions row 별로 entry 펼치기.
      const expanded = [];
      for (const o of list) {
        if (o.requestType !== "ORDER") continue;
        const wcs = Array.isArray(o.workerCompletions) ? o.workerCompletions : [];
        for (const wc of wcs) {
          if (!wc?.worker || !wc?.completedAt) continue;
          expanded.push({
            order: o,
            worker: wc.worker,
            completedAt: wc.completedAt,
            // entry key 는 order.id + worker — 같은 worksheet 의 다른 직원 entry 를 구분.
            key: `${o.id}__${wc.worker}`,
          });
        }
      }
      setEntries(expanded);
    } catch (err) {
      setError(err.message || "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadOrders();
    // 1분마다 폴링 — 모바일에서 실시간으로 [작업완료] 누르면 자동 반영.
    const t = setInterval(loadOrders, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 기간 필터 — entry.completedAt 기준. 직원 필터는 카드 단계에서 별도 적용해 직원별 칩 건수에 영향 X.
  const periodFiltered = useMemo(
    () => entries.filter((e) => periodMatches(e.completedAt, period)),
    [entries, period],
  );

  // 직원별 건수 — 기간 필터 entry 모음 안에서. 같은 직원이 N건 처리하면 N으로 카운트.
  const workerCounts = useMemo(() => {
    const m = new Map();
    for (const w of ALL_WORKERS) m.set(w, 0);
    for (const e of periodFiltered) {
      m.set(e.worker, (m.get(e.worker) || 0) + 1);
    }
    return Array.from(m.entries())
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  }, [periodFiltered]);

  // 직원 필터까지 적용 + 최근 완료순 정렬.
  const visible = useMemo(() => {
    const list = workerFilter === "ALL"
      ? periodFiltered
      : periodFiltered.filter((e) => e.worker === workerFilter);
    return [...list].sort((a, b) => {
      const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return tb - ta;
    });
  }, [periodFiltered, workerFilter]);

  // 직원 필터가 0건이 되면 자동으로 ALL 로 리셋(예: 기간 변경 시).
  useEffect(() => {
    if (workerFilter === "ALL") return;
    if (!workerCounts.some(([n]) => n === workerFilter)) {
      setWorkerFilter("ALL");
    }
  }, [workerCounts, workerFilter]);

  return (
    <div className="work-status-page">
      <div className="ws-tabs">
        {PERIOD_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`ws-tab ${period === t.key ? "active" : ""}`}
            onClick={() => setPeriod(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span className="ws-tab-count">총 {periodFiltered.length}건</span>
      </div>

      {workerCounts.length > 0 && (
        <div className="ws-worker-chips">
          <button
            type="button"
            className={`ws-worker-chip ws-worker-chip--all ${workerFilter === "ALL" ? "active" : ""}`}
            onClick={() => setWorkerFilter("ALL")}
          >
            <span className="ws-worker-chip-name">전체</span>
            <span className="ws-worker-chip-count">{periodFiltered.length}</span>
          </button>
          {workerCounts.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={`ws-worker-chip ${workerFilter === name ? "active" : ""}`}
              onClick={() => setWorkerFilter(name)}
            >
              <WorkerDot name={name} />
              <span className="ws-worker-chip-name">{name}</span>
              <span className="ws-worker-chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="ws-empty">불러오는 중…</div>
      ) : error ? (
        <div className="ws-empty error">{error}</div>
      ) : visible.length === 0 ? (
        <div className="ws-empty">
          {period === "today"
            ? "오늘 완료 처리된 작업이 아직 없습니다."
            : "표시할 완료 작업이 없습니다."}
        </div>
      ) : (
        <div className="ws-status-grid">
          {visible.map((e) => {
            const o = e.order;
            const dueBadge = getDueBadge(o.dueDate);
            // 같은 슬롯을 공유하는 동료 — 같은 worksheet 을 처리해야 하는 다른 직원들.
            // 그 중 이미 완료한 사람은 따로 표시(한 worksheet 의 다른 entry 카드로도 보임).
            const slotWorkers = getWorkersForSlots(o.departmentSlots);
            const completedSet = new Set(
              (Array.isArray(o.workerCompletions) ? o.workerCompletions : []).map((c) => c.worker),
            );
            const otherWorkers = slotWorkers.filter((w) => w !== e.worker);
            const stillPending = otherWorkers.filter((w) => !completedSet.has(w));
            const hue = getWorkerHue(e.worker);
            return (
              <div className="ws-status-card" key={e.key}>
                <div className="ws-status-thumb">
                  <WorksheetThumbnail
                    pdfUrl={o.worksheetPdfUrl || null}
                    thumbnailUrl={o.worksheetThumbnailUrl || null}
                    fallback={
                      <div className="ws-status-thumb-empty">
                        <span>{o.title || "지시서 없음"}</span>
                      </div>
                    }
                  />
                  <div
                    className="ws-status-worker-tag"
                    style={{
                      background: `hsl(${hue}, 65%, 96%)`,
                      borderColor: `hsl(${hue}, 65%, 80%)`,
                      color: `hsl(${hue}, 65%, 28%)`,
                    }}
                  >
                    <WorkerDot name={e.worker} />
                    <span>{e.worker}</span>
                  </div>
                </div>
                <div className="ws-status-body">
                  <div className="ws-status-meta-row">
                    <span className="ws-status-company">
                      {o.clientCompanyName || "-"}
                    </span>
                    <span className="ws-status-due">
                      {dueBadge && (
                        <span className={`due-badge due-badge--${dueBadge.kind}`}>
                          {dueBadge.text}
                        </span>
                      )}
                      <span className="ws-status-due-text">{formatDueShort(o.dueDate)}</span>
                    </span>
                  </div>
                  <h3 className="ws-status-title">{o.title || o.orderNumber}</h3>
                  <div className="ws-status-foot">
                    <span className="ws-status-num">{o.orderNumber}</span>
                    <span className="ws-status-completed">
                      완료 · {formatCompletedAt(e.completedAt)}
                    </span>
                  </div>
                  {stillPending.length > 0 && (
                    <div className="ws-status-shared" title="같은 슬롯에서 아직 처리 안 한 동료">
                      대기 {stillPending.join(", ")}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
