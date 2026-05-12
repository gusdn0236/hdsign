import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import WorksheetThumbnail from "../../components/common/WorksheetThumbnail.jsx";
import PdfViewer from "../../components/common/PdfViewer.jsx";
import PhotoLightbox from "../../components/common/PhotoLightbox.jsx";
import {
  ALL_WORKERS,
  getWorkersForSlots,
  getWorkerHue,
} from "../../data/workers.js";
import "./OrderAdmin.css";
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

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DELIVERY_LABELS = {
  CARGO: "화물 발송",
  QUICK: "퀵 발송",
  DIRECT: "직접 배송",
  PICKUP: "직접 수령",
  LOCAL_CARGO: "지방화물차 배송",
};

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

// 작업현황 전용 상세 모달 — 발주관리로 이동하지 않고 이 탭에서 바로 띄운다(완조립 사진/지시서 확인용).
// 읽기 전용: 지시서 PDF + 완료 사진 캐러셀 + 주문 정보 + 배부 인원. 상태 변경은 발주관리에서.
function WorkStatusDetailModal({ card, hasPrev, hasNext, onPrev, onNext, onClose }) {
  const order = card?.order || null;
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const evidenceFiles = useMemo(() => {
    const list = Array.isArray(order?.files) ? order.files : [];
    return list
      .filter((f) => f.isEvidence)
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
  }, [order]);

  const workFiles = useMemo(() => {
    const list = Array.isArray(order?.files) ? order.files : [];
    return list.filter((f) => !f.isEvidence);
  }, [order]);

  const carouselSlides = useMemo(() => {
    const slides = [];
    if (order?.worksheetPdfUrl) slides.push({ type: "pdf", url: order.worksheetPdfUrl });
    evidenceFiles.forEach((file, idx) => slides.push({ type: "photo", file, photoIndex: idx }));
    return slides;
  }, [order, evidenceFiles]);

  const evidencePhotos = useMemo(
    () =>
      evidenceFiles.map((file) => ({
        src: file.fileUrl,
        alt: file.originalName,
        dept: file.uploadedDepartment || "부서 미상",
        time: formatDateTime(file.createdAt),
      })),
    [evidenceFiles],
  );

  // 카드가 바뀌면 캐러셀/라이트박스 초기화.
  useEffect(() => {
    setCarouselIndex(0);
    setLightboxIndex(null);
  }, [order?.id]);

  // 모달 열린 동안 body 스크롤 잠금 + ESC/←/→ 키 처리.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (lightboxIndex != null) return; // 라이트박스가 키를 우선 처리.
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onPrev();
      else if (e.key === "ArrowRight" && hasNext) onNext();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [lightboxIndex, hasPrev, hasNext, onPrev, onNext, onClose]);

  if (!order) return null;

  const slide = carouselSlides[carouselIndex] || carouselSlides[0];
  const completedMap = new Map((card.completed || []).map((wc) => [wc.worker, wc.completedAt]));

  return (
    <>
      <div
        className="order-preview-modal"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="order-preview-content">
          <button type="button" className="order-modal-close" onClick={onClose}>
            ×
          </button>

          <div className="order-preview-left">
            <div className="order-file-stage">
              {carouselSlides.length === 0 ? (
                <div className="order-preview-file-fallback">
                  <p className="fallback-title">표시할 자료 없음</p>
                  <p className="fallback-desc">지시서 PDF나 작업 사진이 아직 없습니다.</p>
                </div>
              ) : slide.type === "pdf" ? (
                <div key={slide.url} className="order-preview-pdf">
                  <PdfViewer url={slide.url} />
                </div>
              ) : (
                <button
                  type="button"
                  className="order-carousel-photo"
                  onClick={() => setLightboxIndex(slide.photoIndex)}
                  title="크게 보기"
                >
                  <img src={slide.file.fileUrl} alt={slide.file.originalName} />
                  <div className="order-carousel-photo-meta">
                    <span>{slide.file.uploadedDepartment || "부서 미상"}</span>
                    <span>{formatDateTime(slide.file.createdAt)}</span>
                  </div>
                </button>
              )}

              {carouselSlides.length > 1 && (
                <>
                  <button
                    type="button"
                    className="order-carousel-nav prev"
                    onClick={() =>
                      setCarouselIndex((i) => (i - 1 + carouselSlides.length) % carouselSlides.length)
                    }
                    aria-label="이전"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="order-carousel-nav next"
                    onClick={() => setCarouselIndex((i) => (i + 1) % carouselSlides.length)}
                    aria-label="다음"
                  >
                    ›
                  </button>
                  <div className="order-carousel-dots">
                    {carouselSlides.map((s, idx) => (
                      <button
                        type="button"
                        key={`${s.type}-${idx}`}
                        className={`order-carousel-dot ${idx === carouselIndex ? "active" : ""}`}
                        onClick={() => setCarouselIndex(idx)}
                        aria-label={s.type === "pdf" ? "지시서" : `사진 ${idx}`}
                      />
                    ))}
                  </div>
                  <div className="order-carousel-counter">
                    {carouselIndex + 1} / {carouselSlides.length}
                    {carouselSlides[carouselIndex]?.type === "pdf" ? " · 지시서" : " · 작업 사진"}
                  </div>
                </>
              )}
            </div>

            {workFiles.length > 0 && (
              <div className="order-file-strip">
                {workFiles.map((file, index) => (
                  <a
                    key={file.id || `${file.originalName}-${index}`}
                    className="order-file-chip"
                    href={file.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.originalName}
                  </a>
                ))}
              </div>
            )}
          </div>

          <aside className="order-preview-info">
            <p className="modal-order-no">{order.orderNumber}</p>
            <h3 className="modal-order-title">{order.title || order.orderNumber}</h3>

            {(hasPrev || hasNext) && (
              <div className="modal-order-nav-row">
                <button
                  type="button"
                  className="modal-order-nav-btn"
                  onClick={onPrev}
                  disabled={!hasPrev}
                  title="이전 작업 (←)"
                >
                  <span className="modal-order-nav-arrow">‹</span>
                  <span>이전 작업</span>
                </button>
                <button
                  type="button"
                  className="modal-order-nav-btn"
                  onClick={onNext}
                  disabled={!hasNext}
                  title="다음 작업 (→)"
                >
                  <span>다음 작업</span>
                  <span className="modal-order-nav-arrow">›</span>
                </button>
              </div>
            )}

            <div className="modal-detail-grid">
              <div className="detail-section">
                <span className="detail-label">거래처</span>
                <span className="detail-value">{order.clientCompanyName || "-"}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">추가 물품</span>
                <span className="detail-value">{order.additionalItems || "-"}</span>
              </div>
              <div className="detail-section">
                <span className="detail-label">납기</span>
                <span className="detail-value">
                  {formatDueShort(order.dueDate)}
                  {order.dueTime ? ` (${order.dueTime})` : ""}
                </span>
              </div>
              <div className="detail-section">
                <span className="detail-label">배송 방법</span>
                <span className="detail-value">{DELIVERY_LABELS[order.deliveryMethod] || "-"}</span>
              </div>
              <div className="detail-section full">
                <span className="detail-label">배송 주소</span>
                <span className="detail-value">{order.deliveryAddress || "-"}</span>
              </div>
              <div className="detail-section full">
                <span className="detail-label">요청사항</span>
                <span className="detail-value">{order.note || "-"}</span>
              </div>
              {(order.worksheetChangeNote || "").trim() && (
                <div className="detail-section full">
                  <span className="detail-label">지시서 변경 메모</span>
                  <span className="detail-value">{order.worksheetChangeNote.trim()}</span>
                </div>
              )}
            </div>

            {card.roster?.length > 0 && (
              <div className="modal-detail-grid">
                <div className="detail-section full">
                  <span className="detail-label">
                    배부 인원 · 완료 {card.completed.length}/{card.roster.length}
                  </span>
                  <div className="ws-roster-list" style={{ marginTop: 6 }}>
                    {card.roster.map((name) => {
                      const at = completedMap.get(name);
                      const done = !!at;
                      return (
                        <span
                          key={name}
                          className={`ws-roster-chip ws-roster-chip--${done ? "done" : "pending"}`}
                          title={done ? `${name} · ${formatCompletedAt(at)}` : `${name} · 대기`}
                        >
                          {done ? (
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M3.5 8.5l3 3 6-7" />
                            </svg>
                          ) : (
                            <span className="ws-roster-pin" aria-hidden="true" />
                          )}
                          {name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      <PhotoLightbox
        photos={evidencePhotos}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndexChange={setLightboxIndex}
      />
    </>
  );
}

export default function WorkStatus() {
  const { token } = useAuth();
  // 카드 클릭 → 이 탭에서 바로 상세 모달(완조립 사진/지시서 확인용). 닫으면 작업현황 그대로.
  const [detailOrderId, setDetailOrderId] = useState(null);
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
        const slotSet = new Set(slotWorkers);
        // 슬롯 순서 우선 + 슬롯 외 완료자(드문 경우: 슬롯이 바뀌었는데 과거에 완료한 사람)는 끝에.
        const extras = completed.filter((c) => !slotSet.has(c.worker)).map((c) => c.worker);
        const roster = [...slotWorkers, ...extras];
        // 카드 정렬 기준 — 가장 최근 완료 시각(마지막 도장 찍힌 시점). 기간 필터도 동일.
        const lastCompletedAt = completed[completed.length - 1].completedAt;
        built.push({ order: o, completed, roster, lastCompletedAt });
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

  // 상세 모달 — 현재 보이는 카드 목록(visible) 안에서 인덱스로 이전/다음 이동.
  const detailIndex = useMemo(
    () => (detailOrderId == null ? -1 : visible.findIndex((c) => c.order.id === detailOrderId)),
    [visible, detailOrderId],
  );
  const detailCard = detailIndex >= 0 ? visible[detailIndex] : null;
  // 데이터가 갱신돼 카드가 사라지면(예: 폴링) 모달도 닫는다.
  useEffect(() => {
    if (detailOrderId != null && detailIndex < 0) setDetailOrderId(null);
  }, [detailOrderId, detailIndex]);

  // 맨 위로 버튼 — 카드가 많아 스크롤이 길어진 경우에만 노출. 400px 넘게 스크롤되면 페이드인.
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
            const hasPhotos = !!o.evidenceLastUploadedAt;
            const worksheetChangeNote = (o.worksheetChangeNote || "").trim();
            const hasWorksheetChange = !!worksheetChangeNote;
            return (
              <div
                className="ws-status-card"
                key={o.id}
                onClick={() => setDetailOrderId(o.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailOrderId(o.id);
                  }
                }}
                title="클릭 — 상세(완조립 사진/지시서) 보기"
              >
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
                  {(hasPhotos || hasWorksheetChange) && (
                    <div className="ws-status-thumb-badges">
                      {hasPhotos && (
                        <span className="row-badge badge-evidence" title="작업 사진이 등록되어 있습니다">사진</span>
                      )}
                      {hasWorksheetChange && (
                        <span className="row-badge badge-worksheet" title={`지시서 변경 메모: ${worksheetChangeNote}`}>변경</span>
                      )}
                    </div>
                  )}
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

                  {/* 배부된 인원 — 슬롯 순서대로 왼쪽부터 일렬, 각자에 ✓/○ 마킹.
                      오른쪽 끝에 "완료 N/M" 진행 라벨. */}
                  {card.roster.length > 0 && (() => {
                    const completedMap = new Map(
                      card.completed.map((wc) => [wc.worker, wc.completedAt]),
                    );
                    return (
                      <div className="ws-roster-row">
                        <div className="ws-roster-list">
                          {card.roster.map((name) => {
                            const at = completedMap.get(name);
                            const done = !!at;
                            return (
                              <span
                                key={name}
                                className={`ws-roster-chip ws-roster-chip--${done ? "done" : "pending"}`}
                                title={done ? `${name} · ${formatCompletedAt(at)}` : `${name} · 대기`}
                              >
                                {done ? (
                                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M3.5 8.5l3 3 6-7" />
                                  </svg>
                                ) : (
                                  <span className="ws-roster-pin" aria-hidden="true" />
                                )}
                                {name}
                              </span>
                            );
                          })}
                        </div>
                        <span className="ws-roster-progress">
                          완료 <strong>{card.completed.length}</strong>
                          <span className="ws-roster-progress-sep">/</span>
                          {card.roster.length}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className={`ws-scroll-top ${showScrollTop ? "is-visible" : ""}`}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        title="맨 위로"
        aria-label="맨 위로"
        aria-hidden={!showScrollTop}
        tabIndex={showScrollTop ? 0 : -1}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 15V5M5 10l5-5 5 5" />
        </svg>
      </button>

      {detailCard && (
        <WorkStatusDetailModal
          card={detailCard}
          hasPrev={detailIndex > 0}
          hasNext={detailIndex >= 0 && detailIndex < visible.length - 1}
          onPrev={() => setDetailOrderId(visible[detailIndex - 1]?.order.id ?? null)}
          onNext={() => setDetailOrderId(visible[detailIndex + 1]?.order.id ?? null)}
          onClose={() => setDetailOrderId(null)}
        />
      )}
    </div>
  );
}
