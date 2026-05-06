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
  // 한 worksheet = 카드 1개. 카드 안에 완료자/대기자 두 그룹을 큼직한 칩으로 묶어 표시.
  // 한 명이라도 완료한 worksheet 만 작업현황에 노출(아직 아무도 안 누른 건 발주관리에 있음).
  const [cards, setCards] = useState([]);
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
      const built = [];
      for (const o of list) {
        if (o.requestType !== "ORDER") continue;
        const wcs = Array.isArray(o.workerCompletions) ? o.workerCompletions : [];
        const completed = wcs
          .filter((c) => c?.worker && c?.completedAt)
          .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime());
        if (completed.length === 0) continue;
        const slotWorkers = getWorkersForSlots(o.departmentSlots);
        const doneSet = new Set(completed.map((c) => c.worker));
        const pending = slotWorkers.filter((w) => !doneSet.has(w));
        // 카드 정렬 기준 — 가장 최근 완료 시각(마지막 도장 찍힌 시점). 기간 필터도 동일.
        const lastCompletedAt = completed[completed.length - 1].completedAt;
        built.push({ order: o, completed, pending, lastCompletedAt });
      }
      setCards(built);
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

  // 기간 필터 — 카드의 마지막 완료 시각 기준.
  const periodFiltered = useMemo(
    () => cards.filter((c) => periodMatches(c.lastCompletedAt, period)),
    [cards, period],
  );

  // 직원별 건수 — 그 직원이 완료한 worksheet 수. 한 worksheet 에 여러 명이 완료해도 각 직원당 +1.
  const workerCounts = useMemo(() => {
    const m = new Map();
    for (const w of ALL_WORKERS) m.set(w, 0);
    for (const card of periodFiltered) {
      for (const wc of card.completed) {
        m.set(wc.worker, (m.get(wc.worker) || 0) + 1);
      }
    }
    return Array.from(m.entries())
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  }, [periodFiltered]);

  // 직원 필터 + 최근 완료순 정렬. 필터된 카드도 안에는 다른 직원의 완료/대기 정보 그대로 보임.
  const visible = useMemo(() => {
    const list = workerFilter === "ALL"
      ? periodFiltered
      : periodFiltered.filter((c) => c.completed.some((wc) => wc.worker === workerFilter));
    return [...list].sort((a, b) => {
      const ta = a.lastCompletedAt ? new Date(a.lastCompletedAt).getTime() : 0;
      const tb = b.lastCompletedAt ? new Date(b.lastCompletedAt).getTime() : 0;
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
          {visible.map((card) => {
            const o = card.order;
            const dueBadge = getDueBadge(o.dueDate);
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
                      최근 완료 · {formatCompletedAt(card.lastCompletedAt)}
                    </span>
                  </div>

                  {/* 완료자 — 초록 배경 chip + 체크 아이콘. 가장 빠른 완료자부터 시간순. */}
                  {card.completed.length > 0 && (
                    <div className="ws-people-row ws-people-row--done">
                      <span className="ws-people-label ws-people-label--done">
                        완료 {card.completed.length}
                      </span>
                      <div className="ws-people-chips">
                        {card.completed.map((wc) => (
                          <span
                            key={wc.worker}
                            className="ws-people-chip ws-people-chip--done"
                            title={`${wc.worker} · ${formatCompletedAt(wc.completedAt)}`}
                          >
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M3.5 8.5l3 3 6-7" />
                            </svg>
                            {wc.worker}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 대기자 — 빨간 점선 outline + 회색 글씨. 같은 슬롯 매핑인데 아직 안 누른 직원. */}
                  {card.pending.length > 0 && (
                    <div className="ws-people-row ws-people-row--pending">
                      <span className="ws-people-label ws-people-label--pending">
                        대기 {card.pending.length}
                      </span>
                      <div className="ws-people-chips">
                        {card.pending.map((name) => (
                          <span key={name} className="ws-people-chip ws-people-chip--pending">
                            {name}
                          </span>
                        ))}
                      </div>
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
