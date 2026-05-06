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
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("today");
  const [workerFilter, setWorkerFilter] = useState("ALL"); // 'ALL' or 직원 이름

  const loadOrders = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("작업 목록을 불러오지 못했습니다.");
      const data = await res.json();
      // 발주(ORDER) + workerCompletedAt 있는 것만. 견적은 작업현황 대상 아님.
      const list = Array.isArray(data) ? data : [];
      setOrders(list.filter((o) => o.requestType === "ORDER" && o.workerCompletedAt));
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

  // 기간 필터 적용 (직원 필터는 카드 단계에서 별도 적용 — 직원별 건수 칩에 영향 주지 않기 위해).
  const periodFiltered = useMemo(
    () => orders.filter((o) => periodMatches(o.workerCompletedAt, period)),
    [orders, period],
  );

  // 직원별 건수 — 기간 필터 결과 안에서. ALL_WORKERS 순서대로(가나다), 0건도 노출 안 함.
  const workerCounts = useMemo(() => {
    const m = new Map();
    for (const w of ALL_WORKERS) m.set(w, 0);
    for (const o of periodFiltered) {
      const name = o.workerCompletedBy;
      if (!name) continue;
      m.set(name, (m.get(name) || 0) + 1);
    }
    return Array.from(m.entries())
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  }, [periodFiltered]);

  // 직원 필터까지 적용 + 최근 완료순 정렬.
  const visible = useMemo(() => {
    const list = workerFilter === "ALL"
      ? periodFiltered
      : periodFiltered.filter((o) => o.workerCompletedBy === workerFilter);
    return [...list].sort((a, b) => {
      const ta = a.workerCompletedAt ? new Date(a.workerCompletedAt).getTime() : 0;
      const tb = b.workerCompletedAt ? new Date(b.workerCompletedAt).getTime() : 0;
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
          {visible.map((o) => {
            const dueBadge = getDueBadge(o.dueDate);
            const slotWorkers = getWorkersForSlots(o.departmentSlots);
            const otherWorkers = slotWorkers.filter((w) => w !== o.workerCompletedBy);
            const hue = getWorkerHue(o.workerCompletedBy);
            return (
              <div className="ws-status-card" key={o.id}>
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
                    <WorkerDot name={o.workerCompletedBy} />
                    <span>{o.workerCompletedBy || "직원"}</span>
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
                      완료 · {formatCompletedAt(o.workerCompletedAt)}
                    </span>
                  </div>
                  {otherWorkers.length > 0 && (
                    <div className="ws-status-shared" title="같은 슬롯을 공유한 동료">
                      공유 {otherWorkers.join(", ")}
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
