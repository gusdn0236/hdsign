import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import PhotoLightbox from "../../components/common/PhotoLightbox.jsx";
import PdfViewer from "../../components/common/PdfViewer.jsx";
import WorksheetThumbnail from "../../components/common/WorksheetThumbnail.jsx";
import KakaoShareButton from "../../components/common/KakaoShareButton.jsx";
import { safeFileName } from "../../utils/shareImage.js";
import "./OrderAdmin.css";

// 자동견적 명세서작성 — 별도 탭이 아니라 주문 상세/카드에서 모달로 띄운다. 무거운 주석입력 UI 라 lazy.
const AutoQuote = lazy(() => import("./autoquote/AutoQuote.tsx"));

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

// 명세서 작성 잠금 — 관리자 계정을 여러 PC 가 공유 로그인하므로, "누가 작성중"을 PC 단위로 구분한다.
// 표시이름과 소유자식별(기기ID) 모두 이 PC 의 localStorage 에만 둔다(서버 공유 계정을 안 건드림).
const EDITOR_NAME_KEY = "hdsign_statement_editor_name";
const DEVICE_ID_KEY = "hdsign_statement_device_id";
function loadEditorName() {
  try { return localStorage.getItem(EDITOR_NAME_KEY) || ""; } catch { return ""; }
}
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage 불가(시크릿 등) — 세션 한정 임시 ID. 같은 탭 동안은 일관됨.
    return `dev-ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}
// 현장 작업뷰어 에이전트(127.0.0.1) — 트레이에 떠 있을 때만 동작. 폴링 없이 클릭 시 한 번만 호출.
const AGENT_URL = import.meta.env.VITE_HDSIGN_AGENT_URL || "http://127.0.0.1:17345";

const STATUS_META = {
  RECEIVED: { label: "접수", className: "status-received" },
  IN_PROGRESS: { label: "작업중", className: "status-in-progress" },
  COMPLETED: { label: "완료", className: "status-completed" },
};

const STATUS_ORDER = ["RECEIVED", "IN_PROGRESS", "COMPLETED"];

const TRASH_RETENTION_DAYS = 30;

const DELIVERY_LABELS = {
  CARGO: "화물 발송",
  QUICK: "퀵 발송",
  DIRECT: "직접 배송",
  PICKUP: "직접 수령",
  LOCAL_CARGO: "지방화물차 배송",
};

const DELIVERY_SHORT_LABELS = {
  CARGO: "화물",
  QUICK: "퀵",
  DIRECT: "직접배송",
  PICKUP: "직접수령",
  LOCAL_CARGO: "지방화물",
  TBD: "추후결정",
};

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

const REQUEST_TYPE_LABELS = {
  ORDER: "발주",
  QUOTE: "견적",
};

function formatDate(value) {
  if (!value) return "-";
  return String(value).split("T")[0];
}

function formatYmd(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateWithDay(value) {
  if (!value) return "-";
  const dateStr = String(value).split("T")[0];
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return `${dateStr} (${WEEKDAY_KO[dt.getDay()]})`;
}

// 완료검토 — 사용자가 "YYYY-MM-DD" 또는 한 자리 월/일("2026-5-9") 로 타이핑한 값을
// 백엔드에 보낼 ISO 8601 형식("2026-05-09") 으로 패딩·검증. 잘못된 입력은 null 반환.
function normalizeReviewDate(input) {
  const m = (input || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// 자유 입력 "YYYY-MM-DD" 의 연도 오타로 비정상 납기가 들어가던 사고 방지(주문-260506-15:
// 2026-05-07 입력 의도로 2027-05-07 저장 → 모바일에서 "5월 7일자" 로만 보여 지난 작업으로
// 착각). 평소 납기 범위(-60~+180일) 안이면 통과, 벗어나면 명시적 확인 다이얼로그.
// 거래처 폼은 14일 버튼만, 워처는 월·일만 받고 연도는 base 에서 가져오므로 거기엔 추가 검증
// 불필요 — 자유 입력이 가능한 검토 모달만 보호.
function confirmIfFarDueDate(isoDate) {
  if (!isoDate) return true;
  const d = new Date(isoDate + "T00:00:00");
  if (Number.isNaN(d.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diffDays > -60 && diffDays < 180) return true;
  const range = diffDays >= 0
    ? `오늘로부터 ${diffDays}일 뒤`
    : `오늘로부터 ${-diffDays}일 전`;
  return window.confirm(
    `납기 ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ` +
    `(${WEEKDAY_KO[d.getDay()]}) — ${range}.\n` +
    `평소 납기 범위(약 2개월 전 ~ 6개월 뒤)를 벗어납니다. 연도가 맞는지 확인하셨습니까?\n\n` +
    `이 날짜로 저장하려면 [확인] 을 누르세요.`
  );
}

function formatDueDate(dueDate, deliveryMethod) {
  if (!dueDate) return "-";
  // 표 컬럼이 좁아 연도는 생략 — 접수일/삭제일과 달리 납기는 보통 2~3주 이내라 월-일로 충분.
  const dateStr = String(dueDate).split("T")[0];
  const [y, m, d] = dateStr.split("-").map(Number);
  let base = dateStr;
  if (y && m && d) {
    const dt = new Date(y, m - 1, d);
    const pad = (n) => String(n).padStart(2, "0");
    const md = `${pad(m)}-${pad(d)}`;
    base = Number.isNaN(dt.getTime()) ? md : `${md} (${WEEKDAY_KO[dt.getDay()]})`;
  }
  const delivery = DELIVERY_SHORT_LABELS[deliveryMethod];
  return delivery ? `${base} ${delivery}` : base;
}

// 바이트 → 사람이 읽는 용량. 발주관리/카드에 작게 표시해 비정상 대용량 업로드(예: 압축 안 된
// 사진으로 수백 MB → 백엔드 OOM)를 한눈에 식별하고 업로드 실패 원인을 빨리 찾기 위함.
function formatFileSize(bytes) {
  if (bytes == null || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
}
// 이 크기 이상이면 '비정상 대용량'으로 경고색 표시 — 보통 지시서는 수 MB 이하다.
const WORKSHEET_SIZE_WARN_BYTES = 20 * 1024 * 1024;

// 카드 그리드의 납기 그룹 헤더용 — '5월 6일 (수)' 만. 오늘/내일/지남 같은 상태는
// getDueBadge 가 별도 컬러 배지로 반환해 헤더에서 함께 렌더한다(모바일 /m/worksheets 동일).
function formatGroupDateLabel(dateStr) {
  if (!dateStr || dateStr === "none") return "납기 미정";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return `${m}월 ${d}일 (${WEEKDAY_KO[dt.getDay()]})`;
}

// 납기 상태 배지 — 오늘/내일/지남 만. 일반 미래 일자는 null(텍스트만 노출).
// dateStr 은 'YYYY-MM-DD' 또는 ISO. 행/카드/그룹헤더 모두 같은 함수로 결정.
function getDueBadge(dateStr) {
  if (!dateStr) return null;
  const ymd = String(dateStr).split("T")[0];
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { kind: "overdue", text: `${-diffDays}일 지남` };
  if (diffDays === 0) return { kind: "today", text: "오늘" };
  if (diffDays === 1) return { kind: "tomorrow", text: "내일" };
  return null;
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function daysLeftUntilPurge(deletedAt) {
  if (!deletedAt) return null;
  const deleted = new Date(deletedAt);
  if (Number.isNaN(deleted.getTime())) return null;
  const purgeAt = deleted.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const diff = purgeAt - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

function getNextStatus(status) {
  const currentIndex = STATUS_ORDER.indexOf(status);
  if (currentIndex < 0 || currentIndex === STATUS_ORDER.length - 1) {
    return null;
  }
  return STATUS_ORDER[currentIndex + 1];
}

// requestType prop 으로 한 페이지 = 한 요청유형. /admin/orders → ORDER, /admin/quotes → QUOTE.
// 둘 다 같은 백엔드 API(/api/admin/orders) 를 쓰지만 클라이언트에서 fetch 직후 한 번 필터링.
// 이렇게 하면 statusCounts/summary/달력 데이터/bulk 액션 등 하위 로직이 자동으로 해당 유형
// 으로 좁혀져 분기 코드를 최소화할 수 있다.
export default function OrderAdmin({ requestType = "ORDER" }) {
  const { token } = useAuth();
  const isOrderPage = requestType === "ORDER";
  const pageTitle = isOrderPage ? "발주 관리" : "견적 관리";
  const [orders, setOrders] = useState([]);
  const [trashOrders, setTrashOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  // R2 사용량 — 작업완료 탭 상단 프로그레스 바. /api/admin/storage/usage 는 60초 캐시라
  // 탭 진입/리프레시마다 호출해도 부담 없음. 영구삭제 후엔 즉시 다시 호출해 줄어든 수치를 본다.
  const [storageUsage, setStorageUsage] = useState(null);
  // "전부삭제" 입력 모달.
  const [purgeAllModalOpen, setPurgeAllModalOpen] = useState(false);
  const [purgeConfirmText, setPurgeConfirmText] = useState("");
  // 기본 진입 — 작업중 탭. 새 주문 받기보단 진행 중인 일과 완료검토가 가장 빈번한 작업이라.
  const [activeFilter, setActiveFilter] = useState("IN_PROGRESS");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  // 자동견적 명세서작성 모달 — 열린 주문 id(없으면 닫힘). 별도 탭이 아니라 OrderAdmin 안 모달로 띄운다.
  const [estimateOrderId, setEstimateOrderId] = useState(null);
  // 명세서 작성중 표시이름 — 이 PC(localStorage)에만 저장. 잠금 소유자 식별용 기기ID 도 이 PC 고유.
  const [editorName, setEditorName] = useState(loadEditorName);
  const [nameDraft, setNameDraft] = useState(loadEditorName);
  const deviceIdRef = useRef(null);
  if (!deviceIdRef.current) deviceIdRef.current = getOrCreateDeviceId();
  // 저장 성공 시 해당 주문의 "명세서" 배지를 즉시 점등(재요청 없이 목록/모달 동기).
  // 작성자 = 이 PC 이름 — 배지에 "ㅇㅇㅇ님: 임시저장" 으로 바로 반영(서버 값과 동일).
  const markEstimateSaved = useCallback((id) => {
    const patch = (o) =>
      o.id === id ? { ...o, hasEstimate: true, estimateEditorName: editorName || o.estimateEditorName } : o;
    setOrders((prev) => prev.map(patch));
    setTrashOrders((prev) => prev.map(patch));
  }, [editorName]);
  // 명세서를 비워 임시저장을 해제했을 때 — '임시저장' 배지를 즉시 제거(원래 빈 상태로).
  const markEstimateCleared = useCallback((id) => {
    const patch = (o) =>
      o.id === id ? { ...o, hasEstimate: false, estimateEditorName: null } : o;
    setOrders((prev) => prev.map(patch));
    setTrashOrders((prev) => prev.map(patch));
  }, []);
  // 이지폼 입력(확정) 시 — '명세서작성완료' 배지를 작업중·작업완료 목록 카드에 즉시 점등(재요청 없이).
  // 이지폼으로 옮겨적은 사람(=이 PC) 이름이 최종 작성자로 뜬다.
  const markEasyformDone = useCallback((id) => {
    const now = new Date().toISOString();
    const patch = (o) =>
      o.id === id
        ? { ...o, hasEstimate: true, easyformUploadedAt: now, estimateEditorName: editorName || o.estimateEditorName }
        : o;
    setOrders((prev) => prev.map(patch));
    setTrashOrders((prev) => prev.map(patch));
  }, [editorName]);
  // 명세서작성 모달이 열린 동안 배경(/admin/orders) 스크롤 잠금.
  useEffect(() => {
    if (estimateOrderId == null) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [estimateOrderId]);

  // 이 PC 의 표시이름 저장 — localStorage 에만 둔다(공유 계정을 안 건드림). 저장하면 이후 이 PC 가
  // 명세서를 작성할 때 다른 PC 화면에 "ㅇㅇㅇ님 작성중" 으로 이 이름이 뜬다.
  const saveDisplayName = useCallback(() => {
    const name = nameDraft.trim();
    if (!name) {
      setFeedback({ type: "error", msg: "이름을 입력해 주세요." });
      return;
    }
    try { localStorage.setItem(EDITOR_NAME_KEY, name); } catch {}
    setEditorName(name);
    setNameDraft(name);
    setFeedback({ type: "success", msg: `이 컴퓨터의 표시 이름을 '${name}' 으로 설정했습니다.` });
  }, [nameDraft]);

  // 명세서 모달이 열려 있는 동안 작성 잠금을 획득·갱신(하트비트)하고, 닫히면 해제한다.
  // 25초마다 하트비트 → 서버 TTL(90초) 안에서 잠금 유지. 탭을 그냥 닫아도 TTL 지나면 자동 만료.
  useEffect(() => {
    if (estimateOrderId == null || !token) return undefined;
    const id = estimateOrderId;
    let cancelled = false;

    const beat = async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/admin/orders/${id}/statement-lock`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ editorId: deviceIdRef.current, editorName }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        // 잠금 상태를 카드 배지에 즉시 반영(재조회 없이).
        const patch = (o) =>
          o.id === id
            ? { ...o, statementEditingBy: data.editingBy, statementEditingName: data.editingName, statementEditingAt: data.editingAt }
            : o;
        setOrders((prev) => prev.map(patch));
        setTrashOrders((prev) => prev.map(patch));
      } catch {
        // 네트워크 일시 오류는 무시 — 다음 하트비트에서 복구.
      }
    };

    beat();
    const timer = setInterval(beat, 25000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // 모달 닫힘 → 잠금 해제(best-effort). keepalive 로 페이지 이탈 중에도 전송 시도.
      // 이 PC(editorId)가 잡은 잠금만 풀리도록 editorId 를 쿼리로 보낸다.
      fetch(`${BASE_URL}/api/admin/orders/${id}/statement-lock?editorId=${encodeURIComponent(deviceIdRef.current)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {});
      const clear = (o) =>
        o.id === id ? { ...o, statementEditingBy: null, statementEditingName: null, statementEditingAt: null } : o;
      setOrders((prev) => prev.map(clear));
      setTrashOrders((prev) => prev.map(clear));
    };
  }, [estimateOrderId, token, editorName]);

  // 이 주문을 '다른 PC'가 지금 작성 중이면 그 표시이름을, 아니면 null. 신선도(TTL 90초) 판정 포함.
  // 이 PC(deviceId)가 작성 중인 잠금은 배지로 안 띄운다(내가 아는 사실이라). 서버 시각은 KST
  // LocalDateTime(존 없음)으로 직렬화되고 클라이언트도 KST 라 new Date() 로컬 해석이 일치한다.
  const STATEMENT_LOCK_TTL_MS = 90 * 1000;
  const statementLockHolder = useCallback((order) => {
    if (!order || !order.statementEditingAt || !order.statementEditingBy) return null;
    if (order.statementEditingBy === deviceIdRef.current) return null; // 이 PC 의 잠금 → 배지 없음
    const t = new Date(order.statementEditingAt).getTime();
    if (!Number.isFinite(t) || Date.now() - t > STATEMENT_LOCK_TTL_MS) return null; // stale
    return order.statementEditingName || "다른 PC";
  }, []);

  // 명세서 모달 열기 — 다른 사람이 작성 중이면 한 번 확인받고 연다(소프트 락: 강제로 열 수 있음).
  const openEstimate = useCallback((order) => {
    const holder = statementLockHolder(order);
    if (holder && !window.confirm(`${holder}님이 이 작업의 명세서를 작성 중입니다.\n중복 작성될 수 있어요. 그래도 여시겠어요?`)) {
      return;
    }
    setEstimateOrderId(order.id);
  }, [statementLockHolder]);
  // 작업현황 등 다른 화면에서 `?order=<id>` 로 넘어오면 그 주문 상세 모달을 바로 연다.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const raw = searchParams.get("order");
    if (!raw) return;
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) setSelectedOrderId(id);
    // 파라미터는 한 번만 소비 — 닫았다가 새로고침/뒤로가기 해도 다시 안 열리게 URL 에서 제거.
    const next = new URLSearchParams(searchParams);
    next.delete("order");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const [trashingOrderId, setTrashingOrderId] = useState(null);
  const [restoringOrderId, setRestoringOrderId] = useState(null);
  const [deletingOrderId, setDeletingOrderId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [openingFsId, setOpeningFsId] = useState(null);
  const [openingFolderId, setOpeningFolderId] = useState(null);
  const [bulkPurging, setBulkPurging] = useState(false);
  // 접수·작업중 탭의 다중 선택 → 일괄 휴지통 이동. 선택모드일 땐 카드 클릭이 모달 대신 체크 토글.
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState(() => new Set());
  const [bulkTrashing, setBulkTrashing] = useState(false);
  // 일괄 완료 검토 — queue 의 주문 한 건씩 PDF 와 적용 납기를 보면서 결정한다.
  // decisions[id] = { action: 'complete' } 또는 { action: 'reschedule', newDate: 'yyyy-MM-dd' }.
  // 모든 주문을 다 보면 selectedOrderId 가 null 로 풀리고 상단 sticky 패널에서 일괄 적용.
  const [reviewSession, setReviewSession] = useState(null);
  const [reviewChoice, setReviewChoice] = useState("complete"); // 'back' | 'complete' | 'reschedule'
  const [reviewStage, setReviewStage] = useState("choose"); // 'choose' | 'pickDate'
  const [reviewDateInput, setReviewDateInput] = useState("");
  const reviewDateInputRef = useRef(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  // 달력 — 보고 있는 월의 1일, 카드 영역에 보여줄 선택 일자(YYYY-MM-DD).
  // 진입 시엔 일자 선택 없이 "전체 보기"(selectedCalendarDate === null)로 시작 —
  // 필터 결과 전체를 날짜별 그룹으로 한 화면에 본다. 달력에서 날짜를 누르면 그날만.
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(null);
  // 거래처 칩 — 엔터/드롭다운 선택으로 추가, 여러 거래처 동시 OR 매칭.
  const [calendarClientChips, setCalendarClientChips] = useState([]);
  const addCalendarChip = (raw) => {
    const v = String(raw || "").trim();
    if (!v) return;
    setCalendarClientChips((arr) => (arr.includes(v) ? arr : [...arr, v]));
  };
  const removeCalendarChip = (chip) => {
    setCalendarClientChips((arr) => arr.filter((c) => c !== chip));
  };

  // 우측 플로팅 도크(검색입력 + 맨위로) — 페이지를 어느 정도 내렸을 때만 페이드인.
  // 카드 그리드까지 닿기 전엔 상단 인라인 검색바가 바로 보이니 굳이 노출하지 않는다.
  const [showFloatingDock, setShowFloatingDock] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowFloatingDock(window.scrollY > 240);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 거래처 검색 Enter → 매칭 카드를 순차 이동. 같은 검색어로 Enter 를 반복 누르면
  // 다음 카드로 넘어가며(끝에 닿으면 처음으로 순환) 한 건씩 "확인 확인 확인" 가능.
  // 검색어가 바뀌면 인덱스 리셋. 라이브 필터(clientSearch) 는 그대로 동작.
  const flashTimerRef = useRef(null);
  const cycleStateRef = useRef({ query: "", index: -1 });
  const scrollToNextClientCard = useCallback((raw) => {
    const q = String(raw || "").trim().toLowerCase();
    if (!q) return;
    // 매칭 가능한 카드는 두 군데 — 단일 일자 그리드 + 전체보기 그룹들 — 의 모든 .order-card.
    // 매번 다시 쿼리해 리렌더로 카드가 추가/제거된 경우에도 일관되게 동작.
    const nodes = Array.from(document.querySelectorAll("[data-order-company]"));
    const matches = nodes.filter((el) => {
      const name = (el.getAttribute("data-order-company") || "").toLowerCase();
      return name && name.includes(q);
    });
    if (matches.length === 0) {
      setFeedback({ type: "info", msg: `"${raw.trim()}" 와 일치하는 카드가 없습니다.` });
      cycleStateRef.current = { query: q, index: -1 };
      return;
    }
    const last = cycleStateRef.current;
    const nextIdx = last.query === q ? (last.index + 1) % matches.length : 0;
    cycleStateRef.current = { query: q, index: nextIdx };
    // 이전 강조가 남아 있을 수 있으므로 모두 지우고 새 타겟에만 부착.
    nodes.forEach((el) => el.classList.remove("order-card--flash"));
    const target = matches[nextIdx];
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("order-card--flash");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      target.classList.remove("order-card--flash");
      flashTimerRef.current = null;
    }, 1600);
    if (matches.length > 1) {
      setFeedback({ type: "info", msg: `${matches.length}건 중 ${nextIdx + 1}번째 — Enter 로 다음` });
    }
  }, []);
  // 검색어가 바뀌면 다음 Enter 부터 0번째로 시작 — clientSearch 변화 시 cycle 인덱스만 리셋.
  useEffect(() => {
    cycleStateRef.current = { query: clientSearch.trim().toLowerCase(), index: -1 };
  }, [clientSearch]);

  const loadOrders = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [activeRes, trashRes] = await Promise.all([
        fetch(`${BASE_URL}/api/admin/orders`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${BASE_URL}/api/admin/orders/trash`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!activeRes.ok) throw new Error("주문 목록을 불러오지 못했습니다.");
      if (!trashRes.ok) throw new Error("작업완료 목록을 불러오지 못했습니다.");
      const activeData = await activeRes.json();
      const trashData = await trashRes.json();
      const filterByType = (arr) =>
        Array.isArray(arr) ? arr.filter((o) => o.requestType === requestType) : [];
      setOrders(filterByType(activeData));
      setTrashOrders(filterByType(trashData));
    } catch (err) {
      if (!silent) setFeedback({ type: "error", msg: err.message || "주문 목록 조회 중 오류가 발생했습니다." });
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadOrders();
    // requestType 이 바뀌면(/admin/orders ↔ /admin/quotes 전환) 다시 가져와서 필터링.
  }, [token, requestType]);

  // R2 사용량 — 작업완료 탭에서 보여줄 프로그레스 바 데이터. 백엔드 60초 캐시이므로
  // 처음 로드 + 작업완료 탭 진입 + 영구삭제 직후에만 호출하면 충분하다.
  const loadStorageUsage = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${BASE_URL}/api/admin/storage/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setStorageUsage(data);
    } catch {
      // 사용량 표시 실패는 본 기능과 무관 — 조용히 무시.
    }
  }, [token]);

  useEffect(() => {
    loadStorageUsage();
  }, [loadStorageUsage]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2200);
    return () => clearTimeout(timer);
  }, [feedback]);

  // 완료검토 — 날짜 수정 단계 진입 시 input 의 "DD" 부분(YYYY-MM-DD 의 마지막 두 글자) 을
  // 자동 선택. <input type="date"> 는 브라우저가 segment 포커스를 내부 처리해 JS 로 일자
  // segment 만 선택할 방법이 없어서 type="text" + setSelectionRange(8, 10) 패턴 사용.
  // 사용자는 보통 일자만 두 자리 타이핑 → Enter 로 저장. 월/년도 변경이 필요하면 그 부분
  // 클릭해서 직접 편집(평소엔 거의 발생 안 함).
  useEffect(() => {
    if (reviewStage !== "pickDate") return;
    const el = reviewDateInputRef.current;
    if (!el) return;
    const rafId = requestAnimationFrame(() => {
      el.focus();
      try {
        el.setSelectionRange(8, 10);
      } catch {
        // 일부 브라우저 — 무시.
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [reviewStage]);

  const selectedOrder = useMemo(
    () =>
      orders.find((order) => order.id === selectedOrderId) ||
      trashOrders.find((order) => order.id === selectedOrderId) ||
      null,
    [orders, trashOrders, selectedOrderId]
  );

  const selectedFiles = useMemo(() => {
    const list = selectedOrder?.files || [];
    const work = [];
    const evidence = [];
    list.forEach((file) => {
      if (file.isEvidence) evidence.push(file);
      else work.push(file);
    });
    evidence.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return { work, evidence };
  }, [selectedOrder]);

  useEffect(() => {
    setLightboxIndex(null);
    setCarouselIndex(0);
  }, [selectedOrderId]);

  // 모달 열린 동안 body 스크롤 잠금 — PDF 뷰어 안에서 휠 굴리면 뒷배경 홈페이지가
  // 스크롤되던 문제 차단. PdfViewer 의 overscroll-behavior:contain 과 이중 안전장치.
  useEffect(() => {
    if (!selectedOrderId) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [selectedOrderId]);

  // 모달이 열릴 때 "본 시각" 갱신 → 행 배지 즉시 클리어.
  // 백엔드 응답을 기다리지 않고 낙관적으로 로컬 상태부터 갱신.
  useEffect(() => {
    if (!selectedOrderId || !token) return;
    const nowIso = new Date().toISOString();
    setOrders((prev) =>
      prev.map((o) => (o.id === selectedOrderId ? { ...o, adminViewedAt: nowIso } : o))
    );
    setTrashOrders((prev) =>
      prev.map((o) => (o.id === selectedOrderId ? { ...o, adminViewedAt: nowIso } : o))
    );
    fetch(`${BASE_URL}/api/admin/orders/${selectedOrderId}/viewed`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, [selectedOrderId, token]);

  const evidencePhotos = useMemo(
    () =>
      selectedFiles.evidence.map((file) => ({
        src: file.fileUrl,
        alt: file.originalName,
        dept: file.uploadedDepartment || "부서 미상",
        time: formatDateTime(file.createdAt),
      })),
    [selectedFiles.evidence]
  );

  // 모달 좌측 캐러셀 슬라이드 — 1번: 지시서 PDF (있으면), 2번~: evidence 사진들.
  // photoIndex 는 클릭 시 PhotoLightbox 가 같은 사진을 풀스크린으로 열기 위해 사용.
  const carouselSlides = useMemo(() => {
    const slides = [];
    if (selectedOrder?.worksheetPdfUrl) {
      // R2 CORS 설정된 환경 — 직접 URL 사용. egress 무료.
      slides.push({ type: "pdf", url: selectedOrder.worksheetPdfUrl });
    }
    selectedFiles.evidence.forEach((file, idx) => {
      slides.push({ type: "photo", file, photoIndex: idx });
    });
    return slides;
  }, [selectedOrder, selectedFiles.evidence]);

  // 모달 캐러셀의 현재 슬라이드를 카톡 공유용 소스로 변환.
  // 지시서(PDF) 는 react-pdf 가 그려둔 캔버스를, 작업 사진은 R2 이미지 URL 을 사용.
  const getCarouselShareSource = useCallback(() => {
    const slide = carouselSlides[carouselIndex] || carouselSlides[0];
    if (!slide) return null;
    if (slide.type === "pdf") {
      const canvas = document.querySelector(".order-preview-pdf canvas");
      return canvas && canvas.width > 0 ? { type: "canvas", canvas } : null;
    }
    return { type: "url", url: slide.file.fileUrl };
  }, [carouselSlides, carouselIndex]);

  const getCarouselShareName = useCallback(() => {
    const slide = carouselSlides[carouselIndex] || carouselSlides[0];
    if (slide?.type === "pdf") {
      const base = selectedOrder?.title || selectedOrder?.orderNumber || "지시서";
      return safeFileName(`${base}_지시서`, "jpg");
    }
    return safeFileName(slide?.file?.originalName || "작업사진", "jpg");
  }, [carouselSlides, carouselIndex, selectedOrder]);

  // 모달 열린 상태에서 ←/→ 로 이전·다음 주문 이동. lightbox 가 열려 있으면 lightbox 가 우선 처리하고,
  // input/textarea/select 에 포커스가 있으면 그쪽 키 입력을 방해하지 않는다.
  // 캐러셀(PDF·작업사진) 키 이동은 화면의 ‹ › 버튼으로 갈음.

  // 지금 진행 중(접수 RECEIVED · 작업중 IN_PROGRESS)인 주문이 1건 이상 등록된 거래처 회사명 Set.
  // 거래처의 가입 상태(ACTIVE/PENDING_SIGNUP 등) 와 무관 — 발주관리에 살아있는 주문이
  // 실제로 들어와 있느냐로 판정. 가입대기 거래처라도 진행 중 주문이 있으면 노출된다.
  // RECEIVED 도 포함해야 대리발주로 갓 등록한 건이 [접수] 탭에서 사라지지 않는다.
  const activeClientNames = useMemo(() => {
    const set = new Set();
    orders.forEach((o) => {
      if ((o.status === "RECEIVED" || o.status === "IN_PROGRESS") && o.clientCompanyName) {
        set.add(o.clientCompanyName);
      }
    });
    return set;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => !o.clientCompanyName || activeClientNames.has(o.clientCompanyName));
  }, [orders, activeClientNames]);

  const statusCounts = useMemo(() => {
    const counts = { RECEIVED: 0, IN_PROGRESS: 0, COMPLETED: 0 };
    filteredOrders.forEach((order) => {
      if (counts[order.status] !== undefined) counts[order.status] += 1;
    });
    return counts;
  }, [filteredOrders]);

  // 지연 건 — 휴지통 안 간 모든 주문(IN_PROGRESS·COMPLETED·접수) 중 dueDate 가 오늘 이전.
  // COMPLETED 도 포함하는 이유: 이전 워크플로우에서 완료 처리만 되고 휴지통으로 안 간 옛 데이터가
  // 새 [완료 검토] 흐름에서도 정리 대상이어야 하므로. 카운트와 일괄 검토 큐 모두 같은 기준.
  const overdueCount = useMemo(() => {
    if (!isOrderPage) return 0;
    const today = formatYmd(new Date());
    return filteredOrders.reduce((acc, o) => {
      if (!o.dueDate) return acc;
      const due = String(o.dueDate).split("T")[0];
      return due < today ? acc + 1 : acc;
    }, 0);
  }, [filteredOrders, isOrderPage]);

  const statusFilteredOrders = useMemo(() => {
    if (activeFilter === "TRASH") return trashOrders;
    // 지연 — 휴지통 가지 않은 모든 활성 주문 중 dueDate 가 오늘 이전. 상태(IN_PROGRESS/COMPLETED/RECEIVED)
    // 무관 — overdueCount 와 같은 기준이라 수치와 보이는 카드 수가 일치.
    if (activeFilter === "OVERDUE") {
      const today = formatYmd(new Date());
      return filteredOrders.filter((o) => o.dueDate && String(o.dueDate).split("T")[0] < today);
    }
    // 작업중 탭은 IN_PROGRESS + 휴지통에 가지 않은 COMPLETED 도 포함 — 새 워크플로우에서 COMPLETED 는
    // 완료검토를 거쳐 바로 휴지통으로 가지만, 이전 데이터(휴지통 안 보낸 COMPLETED) 가 사라지지 않도록.
    if (activeFilter === "IN_PROGRESS") {
      return filteredOrders.filter((o) => o.status === "IN_PROGRESS" || o.status === "COMPLETED");
    }
    // 명세서 탭 — 작업중(IN_PROGRESS·COMPLETED) + 작업완료(휴지통) 전체. 날짜 무관, 최신 업로드순으로
    // 본문에서 다시 정렬한다. 명세서 작성을 단순화하려는 용도라 "올린 순서"로 한 화면에 모아 보여줌.
    if (activeFilter === "STATEMENT") {
      return [
        ...filteredOrders.filter((o) => o.status === "IN_PROGRESS" || o.status === "COMPLETED"),
        ...trashOrders,
      ];
    }
    return filteredOrders.filter((order) => order.status === activeFilter);
  }, [activeFilter, filteredOrders, trashOrders]);

  const availableClients = useMemo(() => {
    const set = new Set();
    statusFilteredOrders.forEach((o) => {
      if (o.clientCompanyName) set.add(o.clientCompanyName);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [statusFilteredOrders]);

  // 달력 뷰 — 칩 OR 필터 + 입력버퍼 라이브 매칭. 정렬/납기범위는 무시(달력이 날짜 피커).
  // 칩이 N개면 부분일치 OR. 입력 중인 버퍼도 한 개의 임시 칩처럼 OR 에 포함시켜,
  // 엔터를 누르기 전부터 결과가 미리 줄어들어 사용자가 의도를 확인할 수 있다.
  const calendarOrdersBase = useMemo(() => {
    const tokens = [...calendarClientChips];
    const buf = clientSearch.trim();
    if (buf) tokens.push(buf);
    if (tokens.length === 0) return statusFilteredOrders;
    const lc = tokens.map((t) => t.toLowerCase());
    return statusFilteredOrders.filter((o) => {
      const name = (o.clientCompanyName || "").toLowerCase();
      return lc.some((t) => name.includes(t));
    });
  }, [statusFilteredOrders, clientSearch, calendarClientChips]);

  // 캘린더 그룹 기준 날짜를 활성 탭에 맞춰 고른다 — 일반 탭은 납기(dueDate),
  // 작업완료 탭은 작업완료 처리일(deletedAt). 작업완료 카드는 모두 deletedAt 이 박혀 있다.
  const isTrashView = activeFilter === "TRASH";
  const calendarDateOf = useCallback((o) => (isTrashView ? o.deletedAt : o.dueDate), [isTrashView]);

  // 'YYYY-MM-DD' → 그 날짜에 해당하는 주문 수 (납기 또는 작업완료 처리일 기준).
  const calendarCountByDate = useMemo(() => {
    const map = new Map();
    calendarOrdersBase.forEach((o) => {
      const raw = calendarDateOf(o);
      if (!raw) return;
      const d = String(raw).split("T")[0];
      map.set(d, (map.get(d) || 0) + 1);
    });
    return map;
  }, [calendarOrdersBase, calendarDateOf]);

  // 6주 × 7일 = 42칸. 첫째 주는 이전 달, 마지막 주는 다음 달로 채워 항상 6줄.
  const calendarCells = useMemo(() => {
    const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const startWeekday = first.getDay();
    const cells = [];
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = new Date(first);
      d.setDate(first.getDate() - (i + 1));
      cells.push({ date: d, currentMonth: false });
    }
    const monthDays = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= monthDays; i++) {
      cells.push({
        date: new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), i),
        currentMonth: true,
      });
    }
    while (cells.length < 42) {
      const last = cells[cells.length - 1].date;
      const d = new Date(last);
      d.setDate(d.getDate() + 1);
      cells.push({ date: d, currentMonth: false });
    }
    return cells;
  }, [calendarMonth]);

  // 선택 일자에 해당하는 주문들 — 일반 탭은 납기일, 작업완료 탭은 작업완료 처리일.
  // 정렬은 등록일(작업완료는 처리일 자체) 최근 순.
  const calendarSelectedOrders = useMemo(() => {
    if (!selectedCalendarDate) return [];
    return calendarOrdersBase
      .filter((o) => {
        const raw = calendarDateOf(o);
        return raw && String(raw).split("T")[0] === selectedCalendarDate;
      })
      .sort((a, b) => {
        const ka = isTrashView ? a.deletedAt : a.createdAt;
        const kb = isTrashView ? b.deletedAt : b.createdAt;
        const ta = ka ? new Date(ka).getTime() : 0;
        const tb = kb ? new Date(kb).getTime() : 0;
        return tb - ta;
      });
  }, [calendarOrdersBase, selectedCalendarDate, calendarDateOf, isTrashView]);

  const todayYmd = useMemo(() => formatYmd(new Date()), []);

  // 전체보기 모드 — selectedCalendarDate === null. 거래처 필터 적용된 전체 주문을
  // 날짜 그룹으로 정렬해 한 화면에 노출. 일반 탭은 가까운 납기 먼저(납기 미정 맨 끝),
  // 작업완료 탭은 최근에 처리된 날짜 먼저(처리일은 모두 박혀 있어 "none" 그룹 없음).
  const isAllView = selectedCalendarDate === null;
  const calendarAllGroups = useMemo(() => {
    if (!isAllView) return [];
    const map = new Map();
    calendarOrdersBase.forEach((o) => {
      const raw = calendarDateOf(o);
      const key = raw ? String(raw).split("T")[0] : "none";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(o);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => {
        if (a === "none") return 1;
        if (b === "none") return -1;
        return isTrashView ? b.localeCompare(a) : a.localeCompare(b);
      })
      .map(([key, list]) => ({
        key,
        dateLabel: formatGroupDateLabel(key),
        badge: isTrashView || key === "none" ? null : getDueBadge(key),
        list,
      }));
  }, [isAllView, calendarOrdersBase, calendarDateOf, isTrashView]);

  const calendarPrevMonth = () =>
    setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const calendarNextMonth = () =>
    setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const calendarGoToToday = () => {
    const d = new Date();
    setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelectedCalendarDate(formatYmd(d));
  };
  const calendarShowAll = () => setSelectedCalendarDate(null);

  // 지연·작업완료 필터 진입 시 자동 전체보기 — 과거 날짜 산재라 단일 일자 뷰면 빈 화면이 흔함.
  // 한 번에 모든 카드를 날짜별 그룹으로 보여줘야 즉시 작업 가능.
  useEffect(() => {
    if (activeFilter === "OVERDUE" || activeFilter === "TRASH") {
      setSelectedCalendarDate(null);
    }
  }, [activeFilter]);

  // 탭을 옮기면 다중 선택 모드/선택 항목 초기화.
  useEffect(() => {
    setBulkSelectMode(false);
    setBulkSelectedIds(new Set());
  }, [activeFilter]);

  const bulkSelectAvailable = activeFilter === "RECEIVED" || activeFilter === "IN_PROGRESS";
  const toggleBulkSelected = (id) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitBulkSelect = () => {
    setBulkSelectMode(false);
    setBulkSelectedIds(new Set());
  };

  // 명세서 탭 — 달력/날짜그룹 없이 작업중+작업완료 전체를 최신 업로드순(createdAt 내림차순)으로 펼친다.
  // 가장 마지막에 올린 지시서 카드가 맨 위. 명세서 작성을 단순화하려는 용도.
  const isStatementView = activeFilter === "STATEMENT";
  const statementOrders = useMemo(() => {
    if (!isStatementView) return [];
    return [...calendarOrdersBase].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [isStatementView, calendarOrdersBase]);

  // 명세서 탭에서만 20초마다 조용히 목록 갱신 → 다른 사람의 "작성중" 배지를 거의 실시간으로 반영.
  // 폴링 방식이라 WebSocket 같은 추가 인프라 불필요. 다른 탭에선 폴링하지 않아 부담 없음.
  useEffect(() => {
    if (!isStatementView || !token) return undefined;
    const timer = setInterval(() => loadOrders({ silent: true }), 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStatementView, token]);

  // 모달 prev/next 의 "현재 화면" 대상 — 명세서 탭은 최신순 평면 목록, 달력 전체보기면 필터된 모든 주문,
  // 그 외엔 선택 일자 카드. 작업완료 탭도 동일 — calendarOrdersBase 가 trashOrders 에 필터 적용된 결과.
  const visibleOrders = useMemo(() => {
    if (isStatementView) return statementOrders;
    if (isAllView) return calendarOrdersBase;
    return calendarSelectedOrders;
  }, [isStatementView, statementOrders, isAllView, calendarOrdersBase, calendarSelectedOrders]);

  const currentOrderIndex = useMemo(() => {
    if (!selectedOrderId) return -1;
    return visibleOrders.findIndex((o) => o.id === selectedOrderId);
  }, [visibleOrders, selectedOrderId]);

  const hasPrevOrder = currentOrderIndex > 0;
  const hasNextOrder = currentOrderIndex >= 0 && currentOrderIndex < visibleOrders.length - 1;
  const goToPrevOrder = () => {
    if (hasPrevOrder) setSelectedOrderId(visibleOrders[currentOrderIndex - 1].id);
  };
  const goToNextOrder = () => {
    if (hasNextOrder) setSelectedOrderId(visibleOrders[currentOrderIndex + 1].id);
  };

  // 모달에 현재 사진이 떠 있는 동안, 곧 볼 사진들을 미리 브라우저 캐시에 받아둔다.
  // 완료검토(28건 등)처럼 주문을 연속으로 넘길 때, 다음 주문 사진을 그때서야 R2 에서
  // 받느라 느린 걸 없앤다. files/fileUrl 은 이미 메모리에 있으므로 추가 API 호출 없이
  // new Image() 로 GET 만 날려 응답을 디스크 캐시에 적재 → 다음 주문은 네트워크 왕복 0.
  //
  // 첫 모달 표시를 방해하지 않는 것이 핵심: 현재 주문의 첫 사진은 JSX <img> 가 즉시
  // 요청하고, 프리페치는 requestIdleCallback(미지원 시 setTimeout) 으로 메인스레드가
  // 한가해진 뒤에야 시작한다. 한 번 받은 URL 은 ref 에 기록해 폴링·재렌더 때 중복 요청 방지.
  const prefetchedUrlsRef = useRef(new Set());
  useEffect(() => {
    if (!selectedOrderId) return undefined;
    // 곧 볼 주문 id 순서 — 검토세션 중이면 큐, 아니면 모달 prev/next 가 쓰는 화면 목록.
    const queue = reviewSession ? reviewSession.queue : visibleOrders.map((o) => o.id);
    const curIdx = queue.indexOf(selectedOrderId);
    if (curIdx < 0) return undefined;

    // 현재 + 다음 3건. 현재 주문도 포함해 같은 주문의 둘째 사진 이후도 미리 받아둔다.
    const lookahead = queue.slice(curIdx, curIdx + 4);
    const findOrder = (id) =>
      orders.find((o) => o.id === id) || trashOrders.find((o) => o.id === id);

    const urls = [];
    lookahead.forEach((id) => {
      const order = findOrder(id);
      (order?.files || []).forEach((f) => {
        if (f.isEvidence && f.fileUrl && !prefetchedUrlsRef.current.has(f.fileUrl)) {
          urls.push(f.fileUrl);
        }
      });
    });
    if (urls.length === 0) return undefined;

    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      urls.forEach((url) => {
        prefetchedUrlsRef.current.add(url);
        const img = new Image();
        img.decoding = "async";
        img.src = url; // 응답이 브라우저 캐시에 적재됨(렌더는 안 함)
      });
    };
    const ric = window.requestIdleCallback;
    const handle = ric ? ric(start, { timeout: 1500 }) : window.setTimeout(start, 400);
    return () => {
      cancelled = true;
      if (ric && window.cancelIdleCallback) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [selectedOrderId, reviewSession, visibleOrders, orders, trashOrders]);

  useEffect(() => {
    if (!selectedOrderId) return;
    const handler = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      const inField = tag === "input" || tag === "textarea" || tag === "select";
      // ESC — lightbox 가 열려 있으면 lightbox 가 먼저 닫힘.
      // 검토 세션 중이면 그냥 닫지 않고 cancelReview 가 확인 다이얼로그를 띄움.
      if (e.key === "Escape") {
        if (lightboxIndex !== null) return;
        e.preventDefault();
        if (reviewSession) {
          cancelReview();
        } else {
          setSelectedOrderId(null);
        }
        return;
      }
      if (lightboxIndex !== null) return;

      // 검토 세션 중 — ←/→ 로 [이전 / 완료 처리 / 납기 수정] 사이를 이동, Enter 로 확정.
      // cursor === 0 이면 '이전' 으로 갈 수 없으므로 좌측 끝은 '완료 처리' 에서 멈춘다.
      if (reviewSession) {
        if (reviewStage === "pickDate") {
          // 날짜 입력 단계는 input 의 onKeyDown 이 처리. ESC 만 위에서 잡고 나머지는 통과.
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setReviewChoice((cur) => {
            if (cur === "reschedule") return "complete";
            if (cur === "complete") return reviewSession.cursor > 0 ? "back" : "complete";
            return "back";
          });
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setReviewChoice((cur) => {
            if (cur === "back") return "complete";
            return "reschedule";
          });
        } else if (e.key === "Enter") {
          if (inField) return;
          e.preventDefault();
          if (reviewChoice === "back") {
            // 이전 지시서로 되돌리기 — 이미 결정한 항목도 다시 보고 변경 가능.
            if (reviewSession.cursor > 0) {
              const newCursor = reviewSession.cursor - 1;
              setReviewSession({ ...reviewSession, cursor: newCursor });
              setSelectedOrderId(reviewSession.queue[newCursor]);
              setReviewChoice("complete");
              setReviewStage("choose");
              setReviewDateInput("");
            }
          } else if (reviewChoice === "complete") {
            commitDecisionAndAdvance({ action: "complete" });
          } else if (reviewChoice === "reschedule") {
            // 적용 납기를 기본값으로 깔고 날짜 입력 단계로 진입.
            const cur = orders.find((o) => o.id === selectedOrderId);
            const dueStr = cur?.dueDate ? String(cur.dueDate).split("T")[0] : "";
            setReviewDateInput(dueStr);
            setReviewStage("pickDate");
          }
        }
        return;
      }

      if (inField) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevOrder();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNextOrder();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedOrderId, lightboxIndex, currentOrderIndex, visibleOrders, reviewSession, reviewStage, reviewChoice, orders]);

  const updateOrderStatus = async (orderId, nextStatus) => {
    if (!nextStatus) return;
    setStatusUpdatingId(orderId);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/${orderId}/status`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        throw new Error("상태 변경에 실패했습니다.");
      }
      const updated = await res.json();
      setOrders((prev) => prev.map((order) => (order.id === orderId ? updated : order)));
      setFeedback({ type: "success", msg: "상태가 변경되었습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "상태 변경 중 오류가 발생했습니다." });
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const moveCompletedToTrash = async (order) => {
    if (!order || order.status !== "COMPLETED") {
      setFeedback({ type: "error", msg: "완료된 요청만 작업완료로 이동할 수 있습니다." });
      return;
    }
    if (!window.confirm(`"${order.orderNumber}" 요청을 작업완료로 이동하시겠습니까?\n${TRASH_RETENTION_DAYS}일 후 자동 삭제되며, 그 전에 복원할 수 있습니다.`)) {
      return;
    }

    setTrashingOrderId(order.id);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.message || "작업완료 이동에 실패했습니다.");
      }

      setOrders((prev) => prev.filter((item) => item.id !== order.id));
      setTrashOrders((prev) => [
        { ...order, deletedAt: new Date().toISOString() },
        ...prev,
      ]);
      if (selectedOrderId === order.id) setSelectedOrderId(null);
      setFeedback({ type: "success", msg: "작업완료로 이동했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "작업완료 이동 중 오류가 발생했습니다." });
    } finally {
      setTrashingOrderId(null);
    }
  };

  // 접수·작업중 탭에서 다중 선택한 주문들을 한꺼번에 휴지통으로. DELETE /orders/{id} 가
  // 상태와 무관하게 soft-delete 하므로 그대로 병렬 호출. 부분 실패는 합쳐서 피드백.
  const bulkMoveToTrash = async () => {
    const ids = Array.from(bulkSelectedIds);
    if (ids.length === 0) {
      setFeedback({ type: "error", msg: "선택된 항목이 없습니다." });
      return;
    }
    if (!window.confirm(`선택한 ${ids.length}건을 작업완료로 이동하시겠습니까?\n${TRASH_RETENTION_DAYS}일 후 자동 삭제되며, 그 전에 복원할 수 있습니다.`)) {
      return;
    }
    setBulkTrashing(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${BASE_URL}/api/admin/orders/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }).then((res) => {
            if (!res.ok) throw new Error(String(id));
            return id;
          })
        )
      );
      const movedIds = new Set(
        results.filter((r) => r.status === "fulfilled").map((r) => r.value)
      );
      const nowIso = new Date().toISOString();
      const movedOrders = orders
        .filter((o) => movedIds.has(o.id))
        .map((o) => ({ ...o, deletedAt: nowIso }));
      setOrders((prev) => prev.filter((o) => !movedIds.has(o.id)));
      setTrashOrders((prev) => [...movedOrders, ...prev]);
      if (selectedOrderId && movedIds.has(selectedOrderId)) setSelectedOrderId(null);
      exitBulkSelect();
      const failed = results.length - movedIds.size;
      if (failed === 0) {
        setFeedback({ type: "success", msg: `${movedIds.size}건을 작업완료로 이동했습니다.` });
      } else {
        setFeedback({ type: "error", msg: `${movedIds.size}건 이동, ${failed}건 실패` });
      }
    } finally {
      setBulkTrashing(false);
    }
  };

  // 완료 검토 시작 — overdue 전체 큐. 한 건씩 PDF 보면서 완료(휴지통 직행) / 납기 수정.
  // overdueCount 와 동일 기준 — 휴지통 안 간 주문 중 dueDate 가 지난 모든 건(상태 무관).
  const startBulkCompleteReview = () => {
    const today = formatYmd(new Date());
    const queue = orders.filter(
      (o) => o.dueDate && String(o.dueDate).split("T")[0] < today
    );
    if (queue.length === 0) {
      setFeedback({ type: "error", msg: "검토할 요청이 없습니다." });
      return;
    }
    setReviewSession({
      queue: queue.map((o) => o.id),
      cursor: 0,
      decisions: {},
    });
    setReviewChoice("complete");
    setReviewStage("choose");
    setReviewDateInput("");
    setSelectedOrderId(queue[0].id);
  };

  // 한 건의 결정을 저장하고 다음 주문으로 이동. 마지막이면 모달 닫고 sticky 패널이 뜬다.
  const commitDecisionAndAdvance = (decision) => {
    if (!reviewSession) return;
    const id = reviewSession.queue[reviewSession.cursor];
    if (id == null) return;
    const nextDecisions = { ...reviewSession.decisions, [id]: decision };
    const nextCursor = reviewSession.cursor + 1;
    if (nextCursor < reviewSession.queue.length) {
      setReviewSession({ ...reviewSession, cursor: nextCursor, decisions: nextDecisions });
      setSelectedOrderId(reviewSession.queue[nextCursor]);
      setReviewChoice("complete");
      setReviewStage("choose");
      setReviewDateInput("");
    } else {
      setReviewSession({ ...reviewSession, cursor: nextCursor, decisions: nextDecisions });
      setSelectedOrderId(null);
      setReviewStage("choose");
      setReviewDateInput("");
    }
  };

  const cancelReview = () => {
    if (!reviewSession) return;
    const decided = Object.keys(reviewSession.decisions).length;
    if (decided > 0 && !window.confirm(`검토 중인 결정 ${decided}건이 있습니다. 모두 버리고 종료할까요?`)) {
      return;
    }
    setReviewSession(null);
    setReviewChoice("complete");
    setReviewStage("choose");
    setReviewDateInput("");
    setSelectedOrderId(null);
  };

  // 모든 검토가 끝난 뒤 "일괄 적용". 완료 = DELETE 로 휴지통 직행(서버에서 status=COMPLETED
  // 자동 처리), 납기 수정 = PUT /due-date. 둘 다 병렬로 보내고 결과를 합쳐 한 번에 피드백.
  const applyBulkReview = async () => {
    if (!reviewSession || bulkApplying) return;
    const entries = Object.entries(reviewSession.decisions);
    if (entries.length === 0) {
      setReviewSession(null);
      return;
    }
    setBulkApplying(true);
    try {
      const completeIds = entries.filter(([, d]) => d.action === "complete").map(([id]) => Number(id));
      const reschedules = entries
        .filter(([, d]) => d.action === "reschedule" && d.newDate)
        .map(([id, d]) => ({ id: Number(id), newDate: d.newDate }));

      const trashPromises = completeIds.map((id) =>
        fetch(`${BASE_URL}/api/admin/orders/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }).then((res) => {
          if (!res.ok) throw new Error(String(id));
          return id;
        })
      );
      const reschedulePromises = reschedules.map(({ id, newDate }) =>
        fetch(`${BASE_URL}/api/admin/orders/${id}/due-date`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ dueDate: newDate }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(String(id));
          return res.json();
        })
      );

      const [trashResults, rescheduleResults] = await Promise.all([
        Promise.allSettled(trashPromises),
        Promise.allSettled(reschedulePromises),
      ]);
      const trashedIds = trashResults
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      const rescheduled = rescheduleResults
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      const trashedSet = new Set(trashedIds);
      const rescheduledMap = new Map(rescheduled.map((o) => [o.id, o]));
      const nowIso = new Date().toISOString();

      // 완료 결정 → 휴지통 이동(active 에서 빼고 trash 에 추가, status=COMPLETED 로 표시).
      setOrders((prev) => {
        const next = [];
        const moved = [];
        prev.forEach((o) => {
          if (trashedSet.has(o.id)) {
            moved.push({ ...o, status: "COMPLETED", deletedAt: nowIso });
            return;
          }
          next.push(rescheduledMap.get(o.id) || o);
        });
        if (moved.length > 0) setTrashOrders((trash) => [...moved, ...trash]);
        return next;
      });

      const failed =
        (trashResults.length - trashedIds.length) + (rescheduleResults.length - rescheduled.length);
      const parts = [];
      if (trashedIds.length > 0) parts.push(`작업완료 이동 ${trashedIds.length}건`);
      if (rescheduled.length > 0) parts.push(`납기 수정 ${rescheduled.length}건`);
      if (failed > 0) parts.push(`실패 ${failed}건`);
      setFeedback({
        type: failed === 0 ? "success" : "error",
        msg: parts.join(", ") || "변경 사항 없음",
      });
      setReviewSession(null);
    } finally {
      setBulkApplying(false);
    }
  };

  const restoreFromTrash = async (order) => {
    setRestoringOrderId(order.id);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.message || "복원에 실패했습니다.");
      }
      const restored = await res.json();
      setTrashOrders((prev) => prev.filter((o) => o.id !== order.id));
      setOrders((prev) => [restored, ...prev]);
      setFeedback({ type: "success", msg: "복원했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "복원 중 오류가 발생했습니다." });
    } finally {
      setRestoringOrderId(null);
    }
  };

  // 영구삭제 = R2 의 첨부·도안·미리보기·지시서 PDF + Order 행까지 모두 하드 삭제. 되돌릴 수 없음.
  // (옛 "아카이브"(최소 레코드 보존) 흐름은 폐기 — 작업완료 30일 경과 시 동일하게 완전 삭제.)
  const deletePermanently = async (order) => {
    if (!window.confirm(`"${order.orderNumber}" 요청을 완전히 삭제하시겠습니까?\n\n첨부 파일·도안·미리보기·지시서 PDF 및 모든 기록이 즉시 사라지며 되돌릴 수 없습니다.`)) {
      return;
    }
    setDeletingOrderId(order.id);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}/permanent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.message || "영구 삭제에 실패했습니다.");
      }
      setTrashOrders((prev) => prev.filter((o) => o.id !== order.id));
      if (selectedOrderId === order.id) setSelectedOrderId(null);
      loadStorageUsage();
      setFeedback({ type: "success", msg: "완전 삭제했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "영구 삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingOrderId(null);
    }
  };

  // [전부 영구삭제] — 실수 누름 방지를 위해 모달에서 "전부삭제" 를 정확히 타이핑해야만
  // 백엔드 호출이 통과한다. 백엔드에서도 동일 확인을 검증해 양쪽에서 막는다.
  const openPurgeAllModal = () => {
    if (trashOrders.length === 0) {
      setFeedback({ type: "error", msg: "작업완료 목록이 비어 있습니다." });
      return;
    }
    setPurgeConfirmText("");
    setPurgeAllModalOpen(true);
  };

  const submitPurgeAll = async () => {
    if (purgeConfirmText.trim() !== "전부삭제") return;
    setBulkPurging(true);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/trash/purge-all`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "전부삭제" }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.message || "전부 영구삭제에 실패했습니다.");
      }
      const data = await res.json();
      const deleted = Number(data?.deleted ?? 0);
      const failed = Number(data?.failed ?? 0);
      setTrashOrders([]);
      if (selectedOrderId) setSelectedOrderId(null);
      setPurgeAllModalOpen(false);
      setPurgeConfirmText("");
      // 줄어든 R2 사용량을 즉시 반영.
      loadStorageUsage();
      if (failed === 0) {
        setFeedback({ type: "success", msg: `${deleted}건을 완전 삭제했습니다.` });
      } else {
        setFeedback({ type: "error", msg: `${deleted}건 삭제, ${failed}건 실패` });
        // 실패 건은 서버에 그대로 남아 있을 수 있으니 목록 동기화.
        loadOrders();
      }
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "전부 영구삭제 중 오류가 발생했습니다." });
    } finally {
      setBulkPurging(false);
    }
  };

  // 작업완료 탭 — 선택된 항목만 완전 삭제. bulkSelectMode + bulkSelectedIds 를 트래시 탭에서도
  // 동일하게 재사용한다. 단건 [영구삭제] 와 동일 엔드포인트, 결과 후 trashOrders 에서 제거.
  const bulkDeleteSelectedTrash = async () => {
    const ids = Array.from(bulkSelectedIds);
    if (ids.length === 0) {
      setFeedback({ type: "error", msg: "선택된 항목이 없습니다." });
      return;
    }
    if (!window.confirm(`선택한 ${ids.length}건을 완전 삭제하시겠습니까?\n첨부 파일과 모든 기록이 즉시 사라지며 되돌릴 수 없습니다.`)) {
      return;
    }
    setBulkPurging(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${BASE_URL}/api/admin/orders/${id}/permanent`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }).then((res) => {
            if (!res.ok) throw new Error(String(id));
            return id;
          })
        )
      );
      const deletedIds = new Set(
        results.filter((r) => r.status === "fulfilled").map((r) => r.value)
      );
      setTrashOrders((prev) => prev.filter((o) => !deletedIds.has(o.id)));
      if (selectedOrderId && deletedIds.has(selectedOrderId)) setSelectedOrderId(null);
      loadStorageUsage();
      exitBulkSelect();
      const failed = results.length - deletedIds.size;
      if (failed === 0) {
        setFeedback({ type: "success", msg: `${deletedIds.size}건을 완전 삭제했습니다.` });
      } else {
        setFeedback({ type: "error", msg: `${deletedIds.size}건 삭제, ${failed}건 실패` });
      }
    } finally {
      setBulkPurging(false);
    }
  };

  const isWatcherRunning = async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch("http://127.0.0.1:5577/ping", {
        signal: ctrl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  };

  const downloadWorksheet = async (e, order) => {
    e.stopPropagation();
    setDownloadingId(order.id);
    try {
      const watcherUp = await isWatcherRunning();
      if (!watcherUp) {
        setFeedback({
          type: "error",
          msg: "지시서 프로그램이 실행 중이지 않습니다. 프로그램을 켠 뒤 다시 시도해 주세요.",
        });
        return;
      }
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}/worksheet-package`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("다운로드 실패");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${order.orderNumber}_지시서.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 다운로드 직후 백엔드에 IN_PROGRESS 를 즉시 영속화한다.
      // 이렇게 안 하면 워처가 /worksheet-acknowledged 를 부르기 전에 loadOrders 가
      // 다시 RECEIVED 로 덮어쓸 수 있어 버튼이 "지시서 자동작성하기" 로 되돌아간다.
      // 워처의 acknowledge 는 멱등(이미 IN_PROGRESS 면 무시)이므로 중복 호출 무해.
      try {
        const statusRes = await fetch(`${BASE_URL}/api/admin/orders/${order.id}/status`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: "IN_PROGRESS" }),
        });
        if (statusRes.ok) {
          const updated = await statusRes.json();
          setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
        } else {
          setOrders((prev) =>
            prev.map((o) => (o.id === order.id ? { ...o, status: "IN_PROGRESS" } : o))
          );
        }
      } catch (_) {
        setOrders((prev) =>
          prev.map((o) => (o.id === order.id ? { ...o, status: "IN_PROGRESS" } : o))
        );
      }
      setFeedback({
        type: "success",
        msg: "ZIP을 다운받았습니다. 워처가 처리되면 자동으로 작업중으로 전환됩니다.",
      });
      setTimeout(loadOrders, 5000);
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "다운로드 중 오류가 발생했습니다." });
    } finally {
      setDownloadingId(null);
    }
  };

  // [FS에서 열기] — 현장 에이전트(field-agent)가 떠 있어야 동작. 사무실 PC 에도 같은 에이전트가
  // 트레이에 떠 있는 케이스에서 발주관리 카드에서 바로 .fs 를 열 수 있게 한다. 폴링 없이
  // 클릭 시 한 번만 호출하고, 실패는 토스트만(에이전트가 알아서 폴더 폴백까지 해줌).
  const handleOpenFs = useCallback(async (e, order) => {
    e.stopPropagation();
    setOpeningFsId(order.id);
    try {
      const res = await fetch(`${AGENT_URL}/open`, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "application/json",
          "X-HDSign-Field": "1",
        },
        body: JSON.stringify({ orderNumber: order.orderNumber }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `에이전트 응답 ${res.status}`);
      }
      const body = await res.json();
      if (body.opened) {
        setFeedback({ type: "success", msg: `FlexiSIGN 으로 여는 중… (${body.matchedFile || ""})` });
      } else {
        setFeedback({ type: "error", msg: body.message || "파일을 찾지 못해 거래처 폴더를 열었습니다." });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        msg: err.message || "에이전트 연결 실패 — 트레이의 HD사인 작업뷰어 프로그램이 켜져있는지 확인하세요.",
      });
    } finally {
      setOpeningFsId(null);
    }
  }, []);

  // [폴더열기] — 현장 에이전트가 그 지시서의 .fs(찾으면) 가 든 폴더, 못 찾으면 거래처 폴더를
  // 탐색기로 연다. handleOpenFs 와 같은 에이전트(/open-folder) 를 호출 — 현장 뷰어와 동일 동작.
  const handleOpenFolder = useCallback(async (e, order) => {
    e.stopPropagation();
    setOpeningFolderId(order.id);
    try {
      const res = await fetch(`${AGENT_URL}/open-folder`, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "application/json",
          "X-HDSign-Field": "1",
        },
        body: JSON.stringify({ orderNumber: order.orderNumber }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `에이전트 응답 ${res.status}`);
      }
      const body = await res.json();
      if (body.opened) {
        setFeedback({ type: "success", msg: body.message || "폴더를 열었습니다." });
      } else {
        setFeedback({ type: "error", msg: body.message || "폴더를 열지 못했습니다." });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        msg: err.message || "에이전트 연결 실패 — 트레이의 HD사인 작업뷰어 프로그램이 켜져있는지 확인하세요.",
      });
    } finally {
      setOpeningFolderId(null);
    }
  }, []);

  const requestLabel = (requestType) => REQUEST_TYPE_LABELS[requestType] || "요청";

  // 주문 카드 1건 렌더 — 카드 뷰와 달력 뷰(선택 일자 카드 영역) 양쪽에서 동일한 마크업 재사용.
  // 클로저로 활성 필터/선택모드/로딩 플래그/핸들러를 모두 캡처하므로 인자는 order 하나면 충분.
  const renderOrderCard = (order) => {
    const isTrash = activeFilter === "TRASH";
    const statusMeta = STATUS_META[order.status] || STATUS_META.RECEIVED;
    const nextStatus = getNextStatus(order.status);
    const updating = statusUpdatingId === order.id;
    const trashing = trashingOrderId === order.id;
    const openingFs = openingFsId === order.id;
    const openingFolder = openingFolderId === order.id;
    // FS 버튼은 지시서가 만들어진 카드에만 — RECEIVED(워크시트 없음) 는 자연히 빠진다.
    const fsReady = !!order.worksheetPdfUrl;
    const daysLeft = isTrash ? daysLeftUntilPurge(order.deletedAt) : null;
    // 사진/변경 태그 — '본 시각(adminViewedAt)' 과 무관하게, 데이터가 존재하면 항상 표시.
    // (열람해도 사라지지 않게 해달라는 요청 — 한 번 보고 나서도 어느 카드에 사진/변경이 있는지 계속 보여야 함)
    const hasPhotos = !!order.evidenceLastUploadedAt;
    // 자동견적 — 명세서 작성됨 / 이지폼 업로드됨 배지. 데이터 존재하면 항상 표시(열람과 무관).
    const hasEstimate = !!order.hasEstimate;
    const easyformUploaded = !!order.easyformUploadedAt;
    // 명세서 작성 잠금 — 다른 사람이 지금 이 작업의 명세서를 작성 중이면 표시이름, 아니면 null.
    const editingHolder = statementLockHolder(order);
    // 명세서를 마지막으로 처리(임시저장/이지폼)한 작성자 이름 — 배지에 "ㅇㅇㅇ님: ..." 로 노출.
    const estimateAuthor = (order.estimateEditorName || "").trim();
    const worksheetChangeNote = (order.worksheetChangeNote || "").trim();
    // 변경 태그 — 지시서가 웹에 두 번째 이상 재반영된 적 있으면(worksheetRevisedAt) 표시.
    // 한 번 찍히면 재인쇄·열람으로도 안 사라지는 영구 신호. 옛 주문(타임스탬프 없이
    // 변경 메모만 남은 건) 호환을 위해 메모 존재도 함께 인정.
    const hasWorksheetChange = !!order.worksheetRevisedAt || !!worksheetChangeNote;
    const worksheetChangeTitle = worksheetChangeNote
      ? `지시서 변경 메모: ${worksheetChangeNote}`
      : "지시서가 변경되었습니다";
    const typeKey = order.requestType === "QUOTE" ? "quote" : "order";
    const isOrderType = order.requestType === "ORDER";
    // 다중 선택 모드 — 접수·작업중 탭은 선택 → 작업완료 이동, 작업완료 탭은 선택 → 완전삭제로 재사용.
    const selecting = bulkSelectMode;
    const checked = selecting && bulkSelectedIds.has(order.id);
    const openCard = () => {
      if (selecting) toggleBulkSelected(order.id);
      else setSelectedOrderId(order.id);
    };
    return (
      <div
        key={order.id}
        data-order-company={order.clientCompanyName || ""}
        className={`order-card order-card--${typeKey} ${isTrash ? "order-card--trash" : ""} ${checked ? "order-card--checked" : ""} ${easyformUploaded ? "order-card--ef-done" : hasEstimate ? "order-card--estimate" : ""}`}
        onClick={openCard}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openCard();
          }
        }}
      >
        <div className="order-card-thumb-wrap">
          <WorksheetThumbnail
            pdfUrl={order.worksheetPdfUrl || null}
            thumbnailUrl={order.worksheetThumbnailUrl || null}
            fallback={
              <div className="order-card-thumb-empty">
                <span className="order-card-thumb-empty-title">
                  {order.title || (isOrderPage ? "지시서 없음" : "견적 문의")}
                </span>
              </div>
            }
          />
          <div className="order-card-thumb-top">
            {selecting ? (
              <span className={`order-card-check ${checked ? "is-checked" : ""}`} aria-hidden="true">
                {checked ? "✓" : ""}
              </span>
            ) : (
              <span aria-hidden="true" />
            )}
            {isTrash ? (
              <span className="status-badge status-trash">
                {daysLeft === null ? "작업완료" : `${daysLeft}일 남음`}
              </span>
            ) : (
              <span className={`status-badge ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            )}
          </div>
          {(hasPhotos || hasWorksheetChange || hasEstimate || easyformUploaded) && (
            <div className="order-card-thumb-badges">
              {hasPhotos && (
                <span className="row-badge badge-evidence" title="작업 사진이 등록되어 있습니다">사진</span>
              )}
              {hasWorksheetChange && (
                <span className="row-badge badge-worksheet" title={worksheetChangeTitle}>변경</span>
              )}
              {/* 임시저장(estimate 저장됨) → 이지폼 자동기입 완료(명세서작성완료) 로 진행. 완료면 완료만 표시.
                  작성자 이름이 있으면 "ㅇㅇㅇ님: 임시저장 / 명세서 완료" 로 누가 했는지 함께 보여준다. */}
              {easyformUploaded ? (
                <span className="row-badge badge-easyform" title="이지폼에 자동기입 완료">
                  {estimateAuthor ? `${estimateAuthor}님: 명세서 완료` : "명세서작성완료"}
                </span>
              ) : hasEstimate ? (
                <span className="row-badge badge-estimate" title="명세서 임시저장됨 (아직 이지폼 미입력)">
                  {estimateAuthor ? `${estimateAuthor}님: 임시저장` : "명세서 임시저장"}
                </span>
              ) : null}
            </div>
          )}
          {editingHolder && (
            <div className="order-card-editing-overlay" title={`${editingHolder}님이 명세서를 작성 중입니다`}>
              <span className="editing-dot" />
              {editingHolder}님 작성중
            </div>
          )}
        </div>

        <div className="order-card-body">
          <div className="order-card-meta-row">
            <span className="order-card-company">{order.clientCompanyName || "-"}</span>
            {(() => {
              const dueBadge = getDueBadge(order.dueDate);
              return (
                <span className="order-card-due">
                  {dueBadge && (
                    <span className={`due-badge due-badge--${dueBadge.kind}`}>{dueBadge.text}</span>
                  )}
                  <span className="order-due-text">
                    {formatDueDate(order.dueDate, order.deliveryMethod)}
                  </span>
                </span>
              );
            })()}
          </div>
          <h3 className="order-card-title">
            {order.title || requestLabel(order.requestType)}
          </h3>
          <div className="order-card-foot">
            <span className="order-card-foot-left">
              <span className="order-card-num">{order.orderNumber}</span>
              {order.worksheetPdfSize ? (
                <span
                  className={`order-card-size${order.worksheetPdfSize >= WORKSHEET_SIZE_WARN_BYTES ? " is-large" : ""}`}
                  title={`지시서 PDF 용량: ${formatFileSize(order.worksheetPdfSize)}${order.worksheetPdfSize >= WORKSHEET_SIZE_WARN_BYTES ? " — 비정상적으로 큽니다(사진 압축 확인)" : ""}`}
                >
                  {formatFileSize(order.worksheetPdfSize)}
                </span>
              ) : null}
            </span>
            <span className="order-card-date">
              {formatDateWithDay(isTrash ? order.deletedAt : order.createdAt)}
            </span>
          </div>

          {!selecting && (
          <div className="order-card-actions" onClick={(e) => e.stopPropagation()}>
            <div className="order-card-toolrow">
            {fsReady && (
              <button
                type="button"
                className="order-card-tool action-fs"
                onClick={(e) => handleOpenFs(e, order)}
                disabled={openingFs}
                title="현장 에이전트로 .fs 를 FlexiSIGN 에서 엽니다"
              >
                <span aria-hidden="true">{openingFs ? "⏳" : "🖥️"}</span>
                <span>FS</span>
              </button>
            )}
            {fsReady && (
              <button
                type="button"
                className="order-card-tool action-folder"
                onClick={(e) => handleOpenFolder(e, order)}
                disabled={openingFolder}
                title="거래처/지시서 폴더를 탐색기로 엽니다"
              >
                <span aria-hidden="true">{openingFolder ? "⏳" : "📁"}</span>
                <span>폴더</span>
              </button>
            )}
            {fsReady && (
              <KakaoShareButton
                className="order-card-tool order-card-share"
                label="공유"
                getSource={() => ({ type: "pdf", url: order.worksheetPdfUrl })}
                fileName={() => safeFileName(`${order.title || order.orderNumber || "지시서"}_지시서`, "jpg")}
              />
            )}
            {/* 명세서작성은 '명세서 탭'에서만 — 작업중·작업완료 탭 카드에는 버튼을 두지 않는다.
                ("ㅇㅇㅇ님 작성중" 잠금 흐름도 명세서 탭으로 분리하기 위함.) */}
            {isStatementView && (
              <button
                type="button"
                className={`order-card-tool action-estimate${order.hasEstimate ? " has" : ""}`}
                onClick={() => openEstimate(order)}
                title={order.hasEstimate ? "명세서 수정 (작성됨)" : "명세서작성"}
              >
                <span aria-hidden="true">📝</span>
                <span>명세서</span>
              </button>
            )}
            </div>
            {/* 작업완료(휴지통) 카드는 복원/영구삭제를 카드에 안 띄운다 — 카드 클릭 시 상세모달에서 처리.
                카드엔 작업중 탭과 똑같이 도구 4개만 노출. */}
            {!isTrash && (
              <div className="order-card-statusrow">
                {/* 새 워크플로우: 작업완료 / 다음 단계 버튼 제거. IN_PROGRESS 카드는 납기가 지나면
                    자동으로 [완료 검토] 버튼만 노출. RECEIVED 는 지시서 자동작성(파일 있는 ORDER) 또는
                    수동 [다음 단계] (QUOTE/QR-only) 만 유지. COMPLETED 는 검토 누락분 휴지통으로. */}
                {isOrderType && order.status === "RECEIVED" && (order.files?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    className="next-status-btn action-worksheet"
                    onClick={(e) => downloadWorksheet(e, order)}
                    disabled={downloadingId === order.id}
                  >
                    {downloadingId === order.id ? "준비 중..." : "지시서 자동작성"}
                  </button>
                )}
                {order.status === "RECEIVED" && !(isOrderType && (order.files?.length ?? 0) > 0) && nextStatus && (
                  <button
                    type="button"
                    className="next-status-btn action-start"
                    onClick={() => updateOrderStatus(order.id, nextStatus)}
                    disabled={updating}
                  >
                    {updating ? "변경 중..." : "다음 단계"}
                  </button>
                )}
                {/* 카드 단건 [완료 검토] 버튼은 제거 — 상단 [지연] 필터 → [일괄 완료 검토] 가
                    유일한 진입점. (개별 버튼은 review 중 키보드 트랩 / 중복 트리거 위험.) */}
                {order.status === "COMPLETED" && getDueBadge(order.dueDate)?.kind !== "overdue" && (
                  <button
                    type="button"
                    className="next-status-btn action-trash"
                    onClick={() => moveCompletedToTrash(order)}
                    disabled={trashing}
                    title="이미 완료 — 작업완료로 이동"
                  >
                    {trashing ? "이동 중..." : "작업완료로"}
                  </button>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="order-admin-page">
      {feedback && <div className={`order-feedback ${feedback.type}`}>{feedback.msg}</div>}

      {/* 메인 필터 — 큰 요약카드 자체가 필터 버튼. review session 중에도 안전하게
          작동하도록 button 으로 만들고, review 중엔 disabled 로 막아 중복 트리거 방지. */}
      <div className={`order-summary ${isOrderPage ? "order-summary--with-overdue" : ""}`}>
        <button
          type="button"
          className={`summary-card summary-received ${activeFilter === "RECEIVED" ? "is-selected" : ""}`}
          onClick={() => setActiveFilter("RECEIVED")}
          disabled={!!reviewSession}
          aria-pressed={activeFilter === "RECEIVED"}
        >
          <span className="summary-count">{statusCounts.RECEIVED}</span>
          <span className="summary-label">접수</span>
        </button>
        <button
          type="button"
          className={`summary-card summary-in-progress ${activeFilter === "IN_PROGRESS" ? "is-selected" : ""}`}
          onClick={() => setActiveFilter("IN_PROGRESS")}
          disabled={!!reviewSession}
          aria-pressed={activeFilter === "IN_PROGRESS"}
        >
          <span className="summary-count">{statusCounts.IN_PROGRESS + statusCounts.COMPLETED}</span>
          <span className="summary-label">작업중</span>
        </button>
        <button
          type="button"
          className={`summary-card summary-completed ${activeFilter === "TRASH" ? "is-selected" : ""}`}
          onClick={() => setActiveFilter("TRASH")}
          disabled={!!reviewSession}
          aria-pressed={activeFilter === "TRASH"}
          title={`완료검토를 마친 항목 — ${TRASH_RETENTION_DAYS}일 후 자동 정리`}
        >
          <span className="summary-count">{trashOrders.length}</span>
          <span className="summary-label">작업완료</span>
        </button>
        {isOrderPage && (
          <button
            type="button"
            className={`summary-card summary-overdue ${overdueCount > 0 ? "is-active" : "is-empty"} ${activeFilter === "OVERDUE" ? "is-selected" : ""}`}
            onClick={() => setActiveFilter("OVERDUE")}
            disabled={!!reviewSession}
            aria-pressed={activeFilter === "OVERDUE"}
            title={overdueCount > 0 ? "지연된 주문만 보기" : "지연된 요청이 없습니다"}
          >
            <span className="summary-count">{overdueCount}</span>
            <span className="summary-label">지연</span>
          </button>
        )}
        {isOrderPage && (
          <button
            type="button"
            className={`summary-card summary-statement ${activeFilter === "STATEMENT" ? "is-selected" : ""}`}
            onClick={() => setActiveFilter("STATEMENT")}
            disabled={!!reviewSession}
            aria-pressed={activeFilter === "STATEMENT"}
            title="작업중·작업완료 전체를 최신 업로드순으로 모아 보기"
          >
            <span className="summary-count">{statusCounts.IN_PROGRESS + statusCounts.COMPLETED + trashOrders.length}</span>
            <span className="summary-label">명세서</span>
          </button>
        )}
      </div>

      <div className="order-sort-row">
          {/* 거래처 필터 — 입력 후 Enter 로 칩 추가, 여러 거래처 OR 매칭. 입력만 하고 Enter
              안 눌러도 라이브 미리보기. 백스페이스로 마지막 칩 제거. */}
          <div className="calendar-chip-box">
            {calendarClientChips.map((chip) => (
              <span key={chip} className="calendar-chip">
                {chip}
                <button
                  type="button"
                  className="calendar-chip-x"
                  onClick={() => removeCalendarChip(chip)}
                  aria-label={`${chip} 제거`}
                  title="제거"
                >×</button>
              </span>
            ))}
            <input
              type="search"
              className="calendar-chip-input"
              placeholder={
                calendarClientChips.length === 0
                  ? "거래처 검색 — Enter 로 해당 카드 위치로 이동"
                  : "거래처 검색..."
              }
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (clientSearch.trim()) scrollToNextClientCard(clientSearch);
                } else if (
                  e.key === "Backspace" &&
                  clientSearch === "" &&
                  calendarClientChips.length > 0
                ) {
                  e.preventDefault();
                  setCalendarClientChips((arr) => arr.slice(0, -1));
                }
              }}
            />
          </div>
          <select
            className="sort-select"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                addCalendarChip(e.target.value);
                e.target.value = "";
              }
            }}
            title="거래처를 골라 칩으로 추가"
          >
            <option value="">+ 거래처 선택</option>
            {availableClients
              .filter((name) => !calendarClientChips.includes(name))
              .map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
          </select>
          {(calendarClientChips.length > 0 || clientSearch.trim()) && (
            <button
              type="button"
              className="sort-btn"
              onClick={() => {
                setCalendarClientChips([]);
                setClientSearch("");
              }}
              title="모든 거래처 필터 해제"
            >
              필터 해제
            </button>
          )}
          <span className="sort-result-count">
            {isTrashView
              ? `${calendarOrdersBase.length}건`
              : (() => {
                  const withDue = calendarOrdersBase.filter((o) => !!o.dueDate).length;
                  const noDue = calendarOrdersBase.length - withDue;
                  return (
                    <>
                      {withDue}건
                      {noDue > 0 && ` / 납기 미정 ${noDue}건`}
                    </>
                  );
                })()}
          </span>
        </div>

      {isTrashView && (
        <p className="trash-hint">
          작업완료 항목은 이동일로부터 {TRASH_RETENTION_DAYS}일 후 자동으로 완전 삭제됩니다.
          (첨부·도안·미리보기·지시서 PDF 와 모든 기록이 사라지며 되돌릴 수 없습니다.)
        </p>
      )}

      <div className="order-calendar-view">
        {isStatementView ? (
          <section className="calendar-selected-section">
            <h3 className="calendar-selected-head">
              <span className="order-card-group-date">명세서 — 최신 업로드순</span>
              <span className="order-card-group-count">{statementOrders.length}건</span>
              {/* 이 컴퓨터의 표시이름 — 명세서를 작성하면 다른 PC 화면에 "ㅇㅇㅇ님 작성중" 으로 이 이름이
                  뜬다. 관리자 계정은 공유라 PC 마다 이 이름을 따로 설정(이 PC localStorage 에만 저장). */}
              <span className="statement-myname">
                <span className="statement-myname-label">작성자 이름</span>
                <input
                  type="text"
                  className="statement-myname-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveDisplayName(); }}
                  placeholder="작성자 이름"
                  maxLength={30}
                />
                <button
                  type="button"
                  className="statement-myname-save"
                  onClick={saveDisplayName}
                  disabled={nameDraft.trim() === editorName}
                  title="명세서 작성중 표시에 쓸 작성자 이름 저장"
                >
                  저장
                </button>
              </span>
            </h3>
            {loading ? (
              <div className="order-empty">요청 목록을 불러오는 중입니다.</div>
            ) : statementOrders.length === 0 ? (
              <div className="order-empty">
                {calendarClientChips.length > 0 || clientSearch.trim()
                  ? "필터에 맞는 작업중·작업완료 카드가 없습니다."
                  : "작업중·작업완료 카드가 없습니다."}
              </div>
            ) : (
              <div className="order-card-grid">
                {statementOrders.map(renderOrderCard)}
              </div>
            )}
          </section>
        ) : (
          <>
          <div className="calendar-toolbar">
            <button
              type="button"
              className="calendar-nav-btn"
              onClick={calendarPrevMonth}
              title="이전 달"
              aria-label="이전 달"
            >‹</button>
            <h2 className="calendar-title">
              {calendarMonth.getFullYear()}년 {calendarMonth.getMonth() + 1}월
            </h2>
            <button
              type="button"
              className="calendar-nav-btn"
              onClick={calendarNextMonth}
              title="다음 달"
              aria-label="다음 달"
            >›</button>
            <button
              type="button"
              className="calendar-today-btn"
              onClick={calendarGoToToday}
              title="오늘로 이동"
            >오늘</button>
            <button
              type="button"
              className={`calendar-today-btn calendar-all-btn ${isAllView ? "active" : ""}`}
              onClick={calendarShowAll}
              title="필터 결과 전체를 한 화면에 (날짜별 그룹)"
            >전체 보기</button>
            {/* 우측 끝 그룹 — 필터 알약 + 일괄 완료 검토 버튼.
                계산된 노출 조건: 작업중+전체보기 또는 지연 탭에서 overdue 있을 때 버튼 노출.
                툴바 위치 고정이라 토글 시 달력은 안 움직이고, 빨간 배경으로 한눈에 띔. */}
            <div className="calendar-toolbar-end">
              {(calendarClientChips.length > 0 || clientSearch.trim()) && (
                <span className="calendar-filter-pill">
                  {calendarClientChips.length > 0
                    ? `필터: ${calendarClientChips.join(", ")}${clientSearch.trim() ? ` + ${clientSearch.trim()}` : ""}`
                    : `필터: ${clientSearch.trim()}`}
                </span>
              )}
              {(
                (activeFilter === "OVERDUE" && overdueCount > 0) ||
                (activeFilter === "IN_PROGRESS" && isAllView && overdueCount > 0)
              ) && (
                <button
                  type="button"
                  className="calendar-review-btn"
                  onClick={() => startBulkCompleteReview()}
                  disabled={!!reviewSession}
                  title={`완료 검토 대상 ${overdueCount}건 · 한 건씩 PDF 보며 완료(작업완료) / 납기수정 결정`}
                >
                  {reviewSession ? "검토 중..." : `완료 검토 ${overdueCount}건`}
                </button>
              )}
            </div>
          </div>

          <div className="calendar-grid">
            {WEEKDAY_KO.map((wd, i) => (
              <div
                key={wd}
                className={`calendar-weekday ${i === 0 ? "calendar-weekday--sun" : ""} ${i === 6 ? "calendar-weekday--sat" : ""}`}
              >
                {wd}
              </div>
            ))}
            {calendarCells.map((cell) => {
              const key = formatYmd(cell.date);
              const count = calendarCountByDate.get(key) || 0;
              const isToday = key === todayYmd;
              const isSelected = key === selectedCalendarDate;
              const dow = cell.date.getDay();
              // 작업완료 탭은 모두 과거 날짜라 dueBadge(지난 납기/오늘/내일) 의미가 없음 — 배지 생략.
              const badge = !isTrashView && count > 0 && cell.currentMonth ? getDueBadge(key) : null;
              const ariaCountLabel = isTrashView ? "처리" : "납기";
              return (
                <button
                  key={key + (cell.currentMonth ? "" : "-o")}
                  type="button"
                  className={[
                    "calendar-cell",
                    cell.currentMonth ? "" : "calendar-cell--other",
                    isToday ? "calendar-cell--today" : "",
                    isSelected ? "calendar-cell--selected" : "",
                    count > 0 ? "calendar-cell--has" : "",
                    dow === 0 ? "calendar-cell--sun" : "",
                    dow === 6 ? "calendar-cell--sat" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setSelectedCalendarDate(key)}
                  aria-label={`${cell.date.getMonth() + 1}월 ${cell.date.getDate()}일${count > 0 ? `, ${ariaCountLabel} ${count}건` : ""}`}
                >
                  <span className="calendar-day-num">{cell.date.getDate()}</span>
                  {count > 0 && cell.currentMonth && (
                    <span className={`calendar-day-count ${badge ? `calendar-day-count--${badge.kind}` : ""}`}>
                      {count}건
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 작업완료 탭 — R2 사용량 프로그레스 바. 달력 바로 아래, 카드 위. */}
          {isTrashView && storageUsage && (
            <StorageUsageBar usage={storageUsage} onRefresh={loadStorageUsage} />
          )}

          {/* 작업완료 탭 — 달력 아래, 작업카드 위에 다중 선택/전부 영구삭제 툴바. */}
          {isTrashView && trashOrders.length > 0 && (
            <div className={`bulk-select-row bulk-select-row--trash ${bulkSelectMode ? "is-active" : ""}`}>
              {!bulkSelectMode ? (
                <>
                  <span className="bulk-action-text">작업완료 {trashOrders.length}건</span>
                  <button
                    type="button"
                    className="bulk-select-toggle"
                    onClick={() => setBulkSelectMode(true)}
                    title="여러 건을 골라 한꺼번에 완전 삭제"
                  >
                    ☑ 여러 건 선택
                  </button>
                  {/* 잘못 누르는 사고 방지 — 다른 버튼과 떨어진 맨 우측에 배치. */}
                  <button
                    type="button"
                    className="bulk-delete-btn bulk-delete-btn--rightmost"
                    onClick={openPurgeAllModal}
                    disabled={bulkPurging}
                  >
                    {bulkPurging ? "삭제 중..." : "전부 영구삭제"}
                  </button>
                </>
              ) : (
                <>
                  <span className="bulk-select-count">{bulkSelectedIds.size}건 선택됨</span>
                  <button
                    type="button"
                    className="bulk-delete-btn"
                    onClick={bulkDeleteSelectedTrash}
                    disabled={bulkPurging || bulkSelectedIds.size === 0}
                  >
                    {bulkPurging ? "삭제 중..." : `완전 삭제${bulkSelectedIds.size ? ` (${bulkSelectedIds.size})` : ""}`}
                  </button>
                  <button type="button" className="sort-btn" onClick={exitBulkSelect}>
                    취소
                  </button>
                </>
              )}
            </div>
          )}

          {/* 다중 선택 → 일괄 작업완료 (접수·작업중 탭). 달력 아래, 작업카드 위.
              [전체 선택] 은 의도적으로 두지 않음 — 실수로 한 번에 다 잡혀 작업완료로 넘어가는 사고 방지. */}
          {bulkSelectAvailable && (
            <div className={`bulk-select-row ${bulkSelectMode ? "is-active" : ""}`}>
              {!bulkSelectMode ? (
                <button
                  type="button"
                  className="bulk-select-toggle"
                  onClick={() => setBulkSelectMode(true)}
                  disabled={!!reviewSession || visibleOrders.length === 0}
                  title="여러 건을 골라 한꺼번에 작업완료로 이동"
                >
                  ☑ 여러 건 선택
                </button>
              ) : (
                <>
                  <span className="bulk-select-count">{bulkSelectedIds.size}건 선택됨</span>
                  <button
                    type="button"
                    className="bulk-delete-btn"
                    onClick={bulkMoveToTrash}
                    disabled={bulkTrashing || bulkSelectedIds.size === 0}
                  >
                    {bulkTrashing ? "이동 중..." : `작업완료로 이동${bulkSelectedIds.size ? ` (${bulkSelectedIds.size})` : ""}`}
                  </button>
                  <button type="button" className="sort-btn" onClick={exitBulkSelect}>
                    취소
                  </button>
                </>
              )}
            </div>
          )}

          <section className="calendar-selected-section">
            {isAllView ? (
              loading ? (
                <div className="order-empty">요청 목록을 불러오는 중입니다.</div>
              ) : calendarOrdersBase.length === 0 ? (
                <div className="order-empty">
                  {calendarClientChips.length > 0 || clientSearch.trim()
                    ? "필터에 맞는 주문이 없습니다."
                    : "표시할 주문이 없습니다."}
                </div>
              ) : (
                <>
                  <h3 className="calendar-selected-head">
                    <span className="order-card-group-date">전체 보기</span>
                    <span className="order-card-group-count">{calendarOrdersBase.length}건</span>
                  </h3>
                  {calendarAllGroups.map((group) => (
                    <section className="order-card-group" key={group.key}>
                      <h4 className="order-card-group-head">
                        {group.badge && (
                          <span className={`due-badge due-badge--lg due-badge--${group.badge.kind}`}>{group.badge.text}</span>
                        )}
                        <span className="order-card-group-date">{group.dateLabel}</span>
                        <span className="order-card-group-count">{group.list.length}건</span>
                      </h4>
                      <div className="order-card-grid">
                        {group.list.map(renderOrderCard)}
                      </div>
                    </section>
                  ))}
                </>
              )
            ) : (
              <>
                <h3 className="calendar-selected-head">
                  {(() => {
                    // 작업완료 탭은 과거 처리일이라 dueBadge 무의미 — 배지 생략.
                    const badge = isTrashView ? null : getDueBadge(selectedCalendarDate);
                    return (
                      <>
                        {badge && (
                          <span className={`due-badge due-badge--lg due-badge--${badge.kind}`}>{badge.text}</span>
                        )}
                        <span className="order-card-group-date">{formatGroupDateLabel(selectedCalendarDate)}</span>
                        <span className="order-card-group-count">{calendarSelectedOrders.length}건</span>
                      </>
                    );
                  })()}
                </h3>
                {loading ? (
                  <div className="order-empty">요청 목록을 불러오는 중입니다.</div>
                ) : calendarSelectedOrders.length === 0 ? (
                  <div className="order-empty">
                    {isTrashView
                      ? (calendarClientChips.length > 0 || clientSearch.trim()
                          ? "이 날짜에 해당 거래처의 작업완료 처리가 없습니다."
                          : "이 날짜에 작업완료 처리된 건이 없습니다.")
                      : (calendarClientChips.length > 0 || clientSearch.trim()
                          ? "이 날짜에 해당 거래처 납기가 없습니다."
                          : "이 날짜에 납기가 없습니다.")}
                  </div>
                ) : (
                  <div className="order-card-grid">
                    {calendarSelectedOrders.map(renderOrderCard)}
                  </div>
                )}
              </>
            )}
          </section>
          </>
        )}
        </div>

      <PhotoLightbox
        photos={evidencePhotos}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndexChange={setLightboxIndex}
      />

      {selectedOrder && (
        <div
          className="order-preview-modal"
          // mousedown 으로 닫기 — PDF 영역에서 드래그하다 모달 밖에서 마우스를 떼는 경우
          // click 이 backdrop(공통 조상) 에서 발사돼 모달이 닫히는 문제를 방지.
          // mousedown 은 시작 지점 기준이라 PDF 안에서 시작했으면 backdrop 으로 안 옴.
          onMouseDown={(e) => {
            // 검토 세션 중에는 backdrop 클릭으로 실수로 끝나지 않도록 무시.
            if (e.target === e.currentTarget && !reviewSession) setSelectedOrderId(null);
          }}
        >
          {/* 안쪽에 stopPropagation 을 걸면 react-zoom-pan-pinch 가 window 레벨에서
              듣는 mousedown 까지 막혀 PDF 드래그가 동작하지 않는다. backdrop 의
              e.target === e.currentTarget 체크만으로도 자식 클릭은 닫힘을 트리거하지
              않으므로 여기서는 propagation 을 막지 않는다. */}
          <div className={`order-preview-content ${reviewSession ? "order-preview-content--review" : ""}`}>
            <button
              type="button"
              className="order-modal-close"
              onClick={() => (reviewSession ? cancelReview() : setSelectedOrderId(null))}
            >
              ×
            </button>

            <div className="order-preview-left">
              <div className="order-file-stage">
                {carouselSlides.length === 0 ? (
                  <div className="order-preview-file-fallback">
                    <p className="fallback-title">표시할 자료 없음</p>
                    <p className="fallback-desc">지시서 PDF나 작업 사진이 아직 없습니다.</p>
                  </div>
                ) : (
                  (() => {
                    const slide = carouselSlides[carouselIndex] || carouselSlides[0];
                    if (slide.type === "pdf") {
                      // react-pdf 기반 PdfViewer — 줌 변경 시 캔버스를 새 해상도로 다시
                      // 그려 모든 배율에서 선명. 컨트롤 바가 모달 외부 버튼들과 같은
                      // 레벨에 있어 PDF 그리는 동안에도 클릭이 막히지 않음.
                      return (
                        <div key={slide.url} className="order-preview-pdf">
                          <PdfViewer url={slide.url} />
                        </div>
                      );
                    }
                    return (
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
                    );
                  })()
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
                      {carouselSlides.map((slide, idx) => (
                        <button
                          type="button"
                          key={`${slide.type}-${idx}`}
                          className={`order-carousel-dot ${idx === carouselIndex ? "active" : ""}`}
                          onClick={() => setCarouselIndex(idx)}
                          aria-label={slide.type === "pdf" ? "지시서" : `사진 ${idx}`}
                        />
                      ))}
                    </div>
                    <div className="order-carousel-counter">
                      {carouselIndex + 1} / {carouselSlides.length}
                      {carouselSlides[carouselIndex]?.type === "pdf" ? " · 지시서" : " · 작업 사진"}
                    </div>
                  </>
                )}

                {carouselSlides.length > 0 && (
                  <KakaoShareButton
                    className="order-stage-share"
                    label={
                      (carouselSlides[carouselIndex] || carouselSlides[0])?.type === "pdf"
                        ? "지시서 카톡공유"
                        : "사진 카톡공유"
                    }
                    getSource={getCarouselShareSource}
                    fileName={getCarouselShareName}
                  />
                )}
              </div>

              {selectedFiles.work.length > 0 && (
                <div className="order-file-strip">
                  {selectedFiles.work.map((file, index) => (
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
              <p className="modal-order-no">{selectedOrder.orderNumber}</p>
              <h3 className="modal-order-title">
                {selectedOrder.title || requestLabel(selectedOrder.requestType)}
              </h3>

              {(selectedOrder.hasEstimate || selectedOrder.easyformUploadedAt) && (() => {
                const author = (selectedOrder.estimateEditorName || "").trim();
                return (
                  <div className="modal-badges">
                    {selectedOrder.easyformUploadedAt ? (
                      <span className="row-badge badge-easyform" title="이지폼에 자동기입 완료">
                        {author ? `${author}님: 명세서 완료` : "명세서작성완료"}
                      </span>
                    ) : selectedOrder.hasEstimate ? (
                      <span className="row-badge badge-estimate" title="명세서 임시저장됨 (아직 이지폼 미입력)">
                        {author ? `${author}님: 임시저장` : "명세서 임시저장"}
                      </span>
                    ) : null}
                  </div>
                );
              })()}

              {(hasPrevOrder || hasNextOrder) && !reviewSession && (
                <div className="modal-order-nav-row">
                  <button
                    type="button"
                    className="modal-order-nav-btn"
                    onClick={goToPrevOrder}
                    disabled={!hasPrevOrder}
                    title="이전 주문 (←)"
                  >
                    <span className="modal-order-nav-arrow">‹</span>
                    <span>이전 주문</span>
                  </button>
                  {currentOrderIndex >= 0 && visibleOrders.length > 1 && (
                    <span className="modal-order-nav-position">
                      {currentOrderIndex + 1} / {visibleOrders.length}
                    </span>
                  )}
                  <button
                    type="button"
                    className="modal-order-nav-btn"
                    onClick={goToNextOrder}
                    disabled={!hasNextOrder}
                    title="다음 주문 (→)"
                  >
                    <span>다음 주문</span>
                    <span className="modal-order-nav-arrow">›</span>
                  </button>
                </div>
              )}

              <div className="file-chips" style={{ marginBottom: 16 }}>
                <span className={`type-chip type-chip--${selectedOrder.requestType === "QUOTE" ? "quote" : "order"}`}>
                  {requestLabel(selectedOrder.requestType)}
                </span>
              </div>

              <div className="modal-status-block">
                <span className="modal-label">작업 상태</span>
                {selectedOrder.deletedAt ? (
                  <span className="status-badge status-trash">
                    작업완료 · {daysLeftUntilPurge(selectedOrder.deletedAt) ?? 0}일 남음
                  </span>
                ) : (
                  <span className={`status-badge ${(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).className}`}>
                    {(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).label}
                  </span>
                )}
                <div className="modal-status-actions">
                  {/* 자동견적 명세서작성 — '명세서 탭'에서 연 상세모달에서만 노출. 작업중·작업완료 탭에서
                      카드를 열면 이 버튼이 없다(명세서 작성/잠금 흐름을 명세서 탭으로 분리). */}
                  {isStatementView && (
                    <button
                      type="button"
                      className="next-status-btn action-estimate"
                      onClick={() => openEstimate(selectedOrder)}
                      title="이 지시서로 자동견적 명세서를 작성/수정합니다"
                    >
                      {selectedOrder.hasEstimate ? "명세서 수정" : "명세서작성"}
                    </button>
                  )}
                  {selectedOrder.deletedAt ? (
                    <>
                      <button
                        type="button"
                        className="next-status-btn action-restore"
                        disabled={restoringOrderId === selectedOrder.id || deletingOrderId === selectedOrder.id}
                        onClick={() => restoreFromTrash(selectedOrder)}
                      >
                        {restoringOrderId === selectedOrder.id ? "복원 중..." : "복원"}
                      </button>
                      <button
                        type="button"
                        className="next-status-btn action-delete"
                        disabled={deletingOrderId === selectedOrder.id || restoringOrderId === selectedOrder.id}
                        onClick={() => deletePermanently(selectedOrder)}
                      >
                        {deletingOrderId === selectedOrder.id ? "삭제 중..." : "영구삭제"}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* 새 워크플로우: 카드와 동일하게 작업완료/다음 단계 수동 변경 제거.
                          RECEIVED → 지시서 자동작성(ORDER+files) 또는 다음 단계(QUOTE/QR-only).
                          IN_PROGRESS 납기 지나면 [완료 검토] (단건 review session).
                          COMPLETED 잔존분은 [휴지통으로]. */}
                      {selectedOrder.status === "RECEIVED" && selectedOrder.requestType === "ORDER" && (selectedOrder.files?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          className="next-status-btn action-worksheet"
                          disabled={downloadingId === selectedOrder.id}
                          onClick={(e) => downloadWorksheet(e, selectedOrder)}
                        >
                          {downloadingId === selectedOrder.id ? "준비 중..." : "지시서 자동작성하기"}
                        </button>
                      )}
                      {selectedOrder.status === "RECEIVED" && !(selectedOrder.requestType === "ORDER" && (selectedOrder.files?.length ?? 0) > 0) && (
                        <button
                          type="button"
                          className="next-status-btn action-start"
                          disabled={statusUpdatingId === selectedOrder.id}
                          onClick={() => updateOrderStatus(selectedOrder.id, "IN_PROGRESS")}
                        >
                          {statusUpdatingId === selectedOrder.id ? "변경 중..." : "다음 단계"}
                        </button>
                      )}
                      {/* 모달 단건 [완료 검토] 도 제거 — 상단 [지연] 필터 → [일괄 완료 검토] 가 단일 진입점. */}
                      {selectedOrder.status === "COMPLETED" && getDueBadge(selectedOrder.dueDate)?.kind !== "overdue" && (
                        <button
                          type="button"
                          className="next-status-btn action-trash"
                          disabled={trashingOrderId === selectedOrder.id}
                          onClick={() => moveCompletedToTrash(selectedOrder)}
                        >
                          {trashingOrderId === selectedOrder.id ? "이동 중..." : "작업완료로"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="modal-detail-grid">
                <div className="detail-section">
                  <span className="detail-label">거래처</span>
                  <span className="detail-value">{selectedOrder.clientCompanyName || "-"}</span>
                </div>
                <div className="detail-section">
                  <span className="detail-label">요청 유형</span>
                  <span className="detail-value">{requestLabel(selectedOrder.requestType)}</span>
                </div>
                {selectedOrder.requestType !== "QUOTE" && (
                  <>
                    <div className="detail-section">
                      <span className="detail-label">추가 물품</span>
                      <span className="detail-value">{selectedOrder.additionalItems || "-"}</span>
                    </div>
                    <div className="detail-section">
                      <span className="detail-label">납기</span>
                      <span className="detail-value">
                        {formatDate(selectedOrder.dueDate)}
                        {selectedOrder.dueTime ? ` (${selectedOrder.dueTime})` : ""}
                      </span>
                    </div>
                    <div className="detail-section">
                      <span className="detail-label">배송 방법</span>
                      <span className="detail-value">{DELIVERY_LABELS[selectedOrder.deliveryMethod] || "-"}</span>
                    </div>
                    <div className="detail-section full">
                      <span className="detail-label">배송 주소</span>
                      <span className="detail-value">{selectedOrder.deliveryAddress || "-"}</span>
                    </div>
                  </>
                )}
                <div className="detail-section full">
                  <span className="detail-label">{selectedOrder.requestType === "QUOTE" ? "문의 내용" : "요청사항"}</span>
                  <span className="detail-value">{selectedOrder.note || "-"}</span>
                </div>
              </div>

              <div className="modal-file-links">
                <span className="detail-label">첨부 파일</span>
                <div className="file-chips">
                  {selectedFiles.work.length ? (
                    selectedFiles.work.map((file, index) => (
                      <a
                        key={file.id || `${file.originalName}-link-${index}`}
                        href={file.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="file-chip"
                      >
                        {file.originalName}
                      </a>
                    ))
                  ) : (
                    <span className="detail-value">첨부 파일 없음</span>
                  )}
                </div>
              </div>
            </aside>

            {reviewSession && (
              <div className="review-bar">
                <div className="review-bar-left">
                  <span className="review-counter">
                    {reviewSession.cursor + 1} / {reviewSession.queue.length}
                  </span>
                  <span className="review-applied">
                    웹 적용 납기 <strong>{formatDate(selectedOrder.dueDate)}</strong>
                  </span>
                </div>

                {reviewStage === "choose" ? (
                  <div className="review-bar-mid">
                    <button
                      type="button"
                      className={`review-back ${reviewChoice === "back" ? "active" : ""}`}
                      onClick={() => {
                        if (reviewSession.cursor <= 0) return;
                        const newCursor = reviewSession.cursor - 1;
                        setReviewSession({ ...reviewSession, cursor: newCursor });
                        setSelectedOrderId(reviewSession.queue[newCursor]);
                        setReviewChoice("complete");
                        setReviewStage("choose");
                        setReviewDateInput("");
                      }}
                      disabled={reviewSession.cursor <= 0}
                      title="이전 지시서로 돌아가기 (← 로 이동 후 Enter)"
                    >
                      <span className="review-choice-key">
                        {reviewChoice === "back" ? "Enter" : "←"}
                      </span>
                      <span className="review-choice-label">이전</span>
                    </button>
                    <button
                      type="button"
                      className={`review-choice ${reviewChoice === "complete" ? "active" : ""}`}
                      onClick={() => {
                        setReviewChoice("complete");
                        commitDecisionAndAdvance({ action: "complete" });
                      }}
                      title="실제로 납기가 지났음 — 완료로 처리 (← / → 로 이동 후 Enter)"
                    >
                      <span className="review-choice-key">
                        {reviewChoice === "complete" ? "Enter" : "·"}
                      </span>
                      <span className="review-choice-label">완료 처리</span>
                    </button>
                    <button
                      type="button"
                      className={`review-choice ${reviewChoice === "reschedule" ? "active" : ""}`}
                      onClick={() => {
                        setReviewChoice("reschedule");
                        const cur = orders.find((o) => o.id === selectedOrderId);
                        const dueStr = cur?.dueDate ? String(cur.dueDate).split("T")[0] : "";
                        setReviewDateInput(dueStr);
                        setReviewStage("pickDate");
                      }}
                      title="아직 안 지난 작업 — 납기를 새 날짜로 수정 (→ 로 이동 후 Enter)"
                    >
                      <span className="review-choice-key">
                        {reviewChoice === "reschedule" ? "Enter" : "→"}
                      </span>
                      <span className="review-choice-label">납기 수정</span>
                    </button>
                  </div>
                ) : (
                  <div className="review-bar-mid review-bar-mid--date">
                    <span className="review-date-label">새 납기:</span>
                    <input
                      ref={reviewDateInputRef}
                      type="text"
                      className="review-date-input"
                      value={reviewDateInput}
                      placeholder="YYYY-MM-DD"
                      maxLength={10}
                      inputMode="numeric"
                      pattern="\d{4}-\d{1,2}-\d{1,2}"
                      onChange={(e) => setReviewDateInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const normalized = normalizeReviewDate(reviewDateInput);
                          if (!normalized) return;
                          if (!confirmIfFarDueDate(normalized)) return;
                          commitDecisionAndAdvance({
                            action: "reschedule",
                            newDate: normalized,
                          });
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setReviewStage("choose");
                          setReviewChoice("reschedule");
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="review-confirm-btn"
                      disabled={!normalizeReviewDate(reviewDateInput)}
                      onClick={() => {
                        const normalized = normalizeReviewDate(reviewDateInput);
                        if (!normalized) return;
                        if (!confirmIfFarDueDate(normalized)) return;
                        commitDecisionAndAdvance({
                          action: "reschedule",
                          newDate: normalized,
                        });
                      }}
                    >
                      저장 (Enter)
                    </button>
                    <button
                      type="button"
                      className="review-back-btn"
                      onClick={() => {
                        setReviewStage("choose");
                        setReviewChoice("reschedule");
                      }}
                    >
                      뒤로
                    </button>
                  </div>
                )}

                <div className="review-bar-right">
                  <button type="button" className="review-cancel-btn" onClick={cancelReview}>
                    검토 종료
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 우측 플로팅 도크 — 화면을 일정 거리 내린 뒤에만 페이드인.
          상단 인라인 검색바와 동일한 clientSearch 를 공유 — 어느 쪽에 타이핑해도 라이브 필터.
          Enter = 매칭 카드 위치로 이동. ↑ = 페이지 맨 위로. */}
      <aside
        className={`order-floating-dock ${showFloatingDock ? "is-visible" : ""}`}
        aria-hidden={!showFloatingDock}
      >
        <div className="order-floating-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5l3 3" />
          </svg>
          <input
            type="search"
            className="order-floating-input"
            placeholder="거래처 검색 (Enter)"
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (clientSearch.trim()) scrollToNextClientCard(clientSearch);
              }
            }}
            tabIndex={showFloatingDock ? 0 : -1}
            aria-label="거래처 검색"
          />
          {clientSearch && (
            <button
              type="button"
              className="order-floating-clear"
              onClick={() => setClientSearch("")}
              aria-label="검색어 지우기"
              title="검색어 지우기"
            >
              ×
            </button>
          )}
        </div>
        <button
          type="button"
          className="order-floating-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title="맨 위로"
          aria-label="맨 위로"
          tabIndex={showFloatingDock ? 0 : -1}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 15V5M5 10l5-5 5 5" />
          </svg>
        </button>
      </aside>

      {reviewSession && !selectedOrderId && (() => {
        const decisions = Object.values(reviewSession.decisions);
        const completes = decisions.filter((d) => d.action === "complete").length;
        const reschedules = decisions.filter((d) => d.action === "reschedule").length;
        return (
          <div className="review-apply-overlay" role="dialog">
            <div className="review-apply-card">
              <h3 className="review-apply-title">검토 완료</h3>
              <p className="review-apply-summary">
                <span><strong>완료 처리</strong> {completes}건</span>
                <span><strong>납기 수정</strong> {reschedules}건</span>
              </p>
              <p className="review-apply-hint">
                일괄 적용을 누르면 완료 처리는 상태가 완료로 바뀌고, 납기 수정은 새 날짜로 갱신됩니다.
              </p>
              <div className="review-apply-actions">
                <button
                  type="button"
                  className="review-apply-cancel"
                  disabled={bulkApplying}
                  onClick={() => {
                    if (window.confirm("검토 결과를 모두 버리고 종료할까요?")) {
                      setReviewSession(null);
                    }
                  }}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="review-apply-go"
                  disabled={bulkApplying || decisions.length === 0}
                  onClick={applyBulkReview}
                >
                  {bulkApplying ? "적용 중..." : "일괄 적용"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 전부 영구삭제 — "전부삭제" 라는 문구를 정확히 타이핑해야 활성화. 비번 입력은 두지 않는다
          (관리자 로그인 후 세션 안이라). 백엔드도 동일 confirmation 을 한 번 더 검증. */}
      {purgeAllModalOpen && (
        <div
          className="purge-all-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !bulkPurging) {
              setPurgeAllModalOpen(false);
              setPurgeConfirmText("");
            }
          }}
        >
          <div className="purge-all-modal">
            <h3 className="purge-all-title">전부 영구삭제</h3>
            <p className="purge-all-body">
              작업완료의 <b>{trashOrders.length}건</b>을 모두 완전 삭제합니다.
              <br />
              첨부 파일·도안·미리보기·지시서 PDF 까지 즉시 사라지며 되돌릴 수 없습니다.
            </p>
            <p className="purge-all-prompt">
              계속하려면 아래 칸에 <b>전부삭제</b> 를 정확히 입력해 주세요.
            </p>
            <input
              type="text"
              className="purge-all-input"
              value={purgeConfirmText}
              onChange={(e) => setPurgeConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && purgeConfirmText.trim() === "전부삭제" && !bulkPurging) {
                  submitPurgeAll();
                }
              }}
              placeholder="전부삭제"
              autoFocus
              disabled={bulkPurging}
            />
            <div className="purge-all-actions">
              <button
                type="button"
                className="purge-all-cancel"
                onClick={() => {
                  setPurgeAllModalOpen(false);
                  setPurgeConfirmText("");
                }}
                disabled={bulkPurging}
              >
                취소
              </button>
              <button
                type="button"
                className="purge-all-confirm"
                onClick={submitPurgeAll}
                disabled={bulkPurging || purgeConfirmText.trim() !== "전부삭제"}
              >
                {bulkPurging ? "삭제 중..." : "전부 영구삭제"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 자동견적 명세서작성 모달 — 별도 탭 대신 여기서 전체화면 오버레이로. ✕ 또는 저장 후 닫기. */}
      {estimateOrderId != null && (
        <div className="aq-modal-overlay" role="dialog" aria-modal="true">
          <Suspense fallback={<div className="aq-modal-loading">명세서 작성기를 불러오는 중…</div>}>
            <AutoQuote
              orderId={estimateOrderId}
              onClose={() => setEstimateOrderId(null)}
              onSaved={() => markEstimateSaved(estimateOrderId)}
              onCleared={() => markEstimateCleared(estimateOrderId)}
              onEasyformUploaded={() => markEasyformDone(estimateOrderId)}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

// 작업완료 탭 상단 — R2 사용량 프로그레스 바. 한도(STORAGE_QUOTA_GB) 대비 사용%를 표시하고,
// 작업완료/작업중/갤러리/orphan 분류로 어디가 차 있는지 한눈에. percent 가 70 이상이면 주황,
// 90 이상이면 빨강으로 변해 정리 신호를 준다.
function StorageUsageBar({ usage, onRefresh }) {
  const totalBytes = Number(usage?.totalBytes ?? 0);
  const quotaBytes = Number(usage?.quotaBytes ?? 1);
  const percent = Math.min(100, Number(usage?.percent ?? 0));
  const quotaGb = Number(usage?.quotaGb ?? 10);
  const trashBytes = Number(usage?.trashBytes ?? 0);
  const activeOrderBytes = Number(usage?.activeOrderBytes ?? 0);
  const galleryBytes = Number(usage?.galleryBytes ?? 0);
  const orphanBytes = Number(usage?.orphanOrderBytes ?? 0);
  const trashOrderCount = Number(usage?.trashOrderCount ?? 0);
  const tone = percent >= 90 ? "danger" : percent >= 70 ? "warn" : "ok";
  const trashPct = quotaBytes > 0 ? (100 * trashBytes) / quotaBytes : 0;
  const activePct = quotaBytes > 0 ? (100 * activeOrderBytes) / quotaBytes : 0;
  const galleryPct = quotaBytes > 0 ? (100 * galleryBytes) / quotaBytes : 0;
  const orphanPct = quotaBytes > 0 ? (100 * orphanBytes) / quotaBytes : 0;
  return (
    <div className={`storage-usage storage-usage--${tone}`}>
      <div className="storage-usage-head">
        <span className="storage-usage-title">서버 저장공간 <span className="storage-usage-server">(Cloudflare R2)</span></span>
        <span className="storage-usage-amount">
          <b>{formatBytes(totalBytes)}</b> / {quotaGb}GB ({percent.toFixed(1)}%)
        </span>
        <button
          type="button"
          className="storage-usage-refresh"
          onClick={onRefresh}
          title="다시 측정 (백엔드 캐시 60초 단위로 자동 갱신)"
        >
          ↻
        </button>
      </div>
      {/* 4-구간 스택 바 — 작업완료 / 작업중 / 갤러리 / orphan(누수) 순. */}
      <div className="storage-usage-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="storage-usage-seg storage-usage-seg--trash" style={{ width: `${trashPct}%` }} />
        <div className="storage-usage-seg storage-usage-seg--active" style={{ width: `${activePct}%` }} />
        <div className="storage-usage-seg storage-usage-seg--gallery" style={{ width: `${galleryPct}%` }} />
        <div className="storage-usage-seg storage-usage-seg--orphan" style={{ width: `${orphanPct}%` }} />
      </div>
      <div className="storage-usage-legend">
        <span><i className="storage-dot storage-dot--trash" />작업완료 {trashOrderCount}건 · {formatBytes(trashBytes)}</span>
        <span><i className="storage-dot storage-dot--active" />작업중 {formatBytes(activeOrderBytes)}</span>
        <span><i className="storage-dot storage-dot--gallery" />갤러리 {formatBytes(galleryBytes)}</span>
        {orphanBytes > 0 && (
          <span title="DB 에 매칭되는 주문이 없는 R2 파일 — 누수 가능성">
            <i className="storage-dot storage-dot--orphan" />미매칭 {formatBytes(orphanBytes)}
          </span>
        )}
      </div>
      {tone !== "ok" && (
        <div className="storage-usage-hint">
          {tone === "danger"
            ? "한도의 90% 를 초과했습니다. [전부 영구삭제] 또는 항목별 [완전 삭제] 로 정리해 주세요."
            : "한도의 70% 를 넘었습니다. 곧 정리를 권장합니다."}
        </div>
      )}
    </div>
  );
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const fixed = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
}
