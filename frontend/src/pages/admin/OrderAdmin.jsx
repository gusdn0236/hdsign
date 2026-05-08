import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import PhotoLightbox from "../../components/common/PhotoLightbox.jsx";
import PdfViewer from "../../components/common/PdfViewer.jsx";
import WorksheetThumbnail from "../../components/common/WorksheetThumbnail.jsx";
import "./OrderAdmin.css";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

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
  // 기본 진입 — 작업중 탭. 새 주문 받기보단 진행 중인 일과 완료검토가 가장 빈번한 작업이라.
  const [activeFilter, setActiveFilter] = useState("IN_PROGRESS");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const [trashingOrderId, setTrashingOrderId] = useState(null);
  const [restoringOrderId, setRestoringOrderId] = useState(null);
  const [deletingOrderId, setDeletingOrderId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [bulkPurging, setBulkPurging] = useState(false);
  // 일괄 완료 검토 — queue 의 주문 한 건씩 PDF 와 적용 납기를 보면서 결정한다.
  // decisions[id] = { action: 'complete' } 또는 { action: 'reschedule', newDate: 'yyyy-MM-dd' }.
  // 모든 주문을 다 보면 selectedOrderId 가 null 로 풀리고 상단 sticky 패널에서 일괄 적용.
  const [reviewSession, setReviewSession] = useState(null);
  const [reviewChoice, setReviewChoice] = useState("complete"); // 'complete' | 'reschedule'
  const [reviewStage, setReviewStage] = useState("choose"); // 'choose' | 'pickDate'
  const [reviewDateInput, setReviewDateInput] = useState("");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  // 달력 — 보고 있는 월의 1일, 카드 영역에 보여줄 선택 일자(YYYY-MM-DD).
  // 진입 시 오늘이 자동 선택되어 즉시 그날 납기 카드가 보이도록 한다.
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => formatYmd(new Date()));
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

  const loadOrders = async () => {
    setLoading(true);
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
      if (!trashRes.ok) throw new Error("휴지통을 불러오지 못했습니다.");
      const activeData = await activeRes.json();
      const trashData = await trashRes.json();
      const filterByType = (arr) =>
        Array.isArray(arr) ? arr.filter((o) => o.requestType === requestType) : [];
      setOrders(filterByType(activeData));
      setTrashOrders(filterByType(trashData));
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "주문 목록 조회 중 오류가 발생했습니다." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadOrders();
    // requestType 이 바뀌면(/admin/orders ↔ /admin/quotes 전환) 다시 가져와서 필터링.
  }, [token, requestType]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2200);
    return () => clearTimeout(timer);
  }, [feedback]);

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

  // 모달 열린 상태에서 ←/→ 로 이전·다음 주문 이동. lightbox 가 열려 있으면 lightbox 가 우선 처리하고,
  // input/textarea/select 에 포커스가 있으면 그쪽 키 입력을 방해하지 않는다.
  // 캐러셀(PDF·작업사진) 키 이동은 화면의 ‹ › 버튼으로 갈음.

  const statusCounts = useMemo(() => {
    const counts = { RECEIVED: 0, IN_PROGRESS: 0, COMPLETED: 0 };
    orders.forEach((order) => {
      if (counts[order.status] !== undefined) counts[order.status] += 1;
    });
    return counts;
  }, [orders]);

  // 지연 건 — 휴지통 안 간 모든 주문(IN_PROGRESS·COMPLETED·접수) 중 dueDate 가 오늘 이전.
  // COMPLETED 도 포함하는 이유: 이전 워크플로우에서 완료 처리만 되고 휴지통으로 안 간 옛 데이터가
  // 새 [완료 검토] 흐름에서도 정리 대상이어야 하므로. 카운트와 일괄 검토 큐 모두 같은 기준.
  const overdueCount = useMemo(() => {
    if (!isOrderPage) return 0;
    const today = formatYmd(new Date());
    return orders.reduce((acc, o) => {
      if (!o.dueDate) return acc;
      const due = String(o.dueDate).split("T")[0];
      return due < today ? acc + 1 : acc;
    }, 0);
  }, [orders, isOrderPage]);

  const statusFilteredOrders = useMemo(() => {
    if (activeFilter === "TRASH") return trashOrders;
    // 지연 — 휴지통 가지 않은 모든 활성 주문 중 dueDate 가 오늘 이전. 상태(IN_PROGRESS/COMPLETED/RECEIVED)
    // 무관 — overdueCount 와 같은 기준이라 수치와 보이는 카드 수가 일치.
    if (activeFilter === "OVERDUE") {
      const today = formatYmd(new Date());
      return orders.filter((o) => o.dueDate && String(o.dueDate).split("T")[0] < today);
    }
    // 작업중 탭은 IN_PROGRESS + 휴지통에 가지 않은 COMPLETED 도 포함 — 새 워크플로우에서 COMPLETED 는
    // 완료검토를 거쳐 바로 휴지통으로 가지만, 이전 데이터(휴지통 안 보낸 COMPLETED) 가 사라지지 않도록.
    if (activeFilter === "IN_PROGRESS") {
      return orders.filter((o) => o.status === "IN_PROGRESS" || o.status === "COMPLETED");
    }
    return orders.filter((order) => order.status === activeFilter);
  }, [activeFilter, orders, trashOrders]);

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

  // 'YYYY-MM-DD' → 그 날짜에 납기인 주문 수.
  const calendarCountByDate = useMemo(() => {
    const map = new Map();
    calendarOrdersBase.forEach((o) => {
      if (!o.dueDate) return;
      const d = String(o.dueDate).split("T")[0];
      map.set(d, (map.get(d) || 0) + 1);
    });
    return map;
  }, [calendarOrdersBase]);

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

  // 선택 일자에 납기인 주문들 — 가까운 등록 순(최근 등록 먼저)으로.
  const calendarSelectedOrders = useMemo(() => {
    if (!selectedCalendarDate) return [];
    return calendarOrdersBase
      .filter((o) => o.dueDate && String(o.dueDate).split("T")[0] === selectedCalendarDate)
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
  }, [calendarOrdersBase, selectedCalendarDate]);

  const todayYmd = useMemo(() => formatYmd(new Date()), []);

  // 전체보기 모드 — selectedCalendarDate === null. 거래처 필터 적용된 전체 주문을
  // 날짜 그룹으로 정렬해 한 화면에 노출. 가까운 납기 먼저, 납기 미정은 맨 끝.
  const isAllView = selectedCalendarDate === null;
  const calendarAllGroups = useMemo(() => {
    if (!isAllView) return [];
    const map = new Map();
    calendarOrdersBase.forEach((o) => {
      const key = o.dueDate ? String(o.dueDate).split("T")[0] : "none";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(o);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => {
        if (a === "none") return 1;
        if (b === "none") return -1;
        return a.localeCompare(b);
      })
      .map(([key, list]) => ({
        key,
        dateLabel: formatGroupDateLabel(key),
        badge: key === "none" ? null : getDueBadge(key),
        list,
      }));
  }, [isAllView, calendarOrdersBase]);

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

  // 지연 필터 진입 시 자동 전체보기 — 과거 날짜 산재라 단일 일자 뷰면 빈 화면이 흔함.
  // 한 번에 모든 지연 카드를 날짜별 그룹으로 보여줘야 즉시 작업 가능.
  useEffect(() => {
    if (activeFilter === "OVERDUE") {
      setSelectedCalendarDate(null);
    }
  }, [activeFilter]);

  // 모달 prev/next 의 "현재 화면" 대상 — 휴지통은 평면 그리드 전체,
  // 달력 전체보기면 필터된 모든 주문, 그 외엔 선택 일자 카드.
  const visibleOrders = useMemo(() => {
    if (activeFilter === "TRASH") return trashOrders;
    if (isAllView) return calendarOrdersBase;
    return calendarSelectedOrders;
  }, [activeFilter, trashOrders, isAllView, calendarOrdersBase, calendarSelectedOrders]);

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

      // 검토 세션 중 — 화살표는 선택 토글, Enter 는 확정. 일반 모드의 prev/next 는 끔.
      if (reviewSession) {
        if (reviewStage === "pickDate") {
          // 날짜 입력 단계는 input 의 onKeyDown 이 처리. ESC 만 위에서 잡고 나머지는 통과.
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setReviewChoice("complete");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setReviewChoice("reschedule");
        } else if (e.key === "Enter") {
          if (inField) return;
          e.preventDefault();
          if (reviewChoice === "complete") {
            commitDecisionAndAdvance({ action: "complete" });
          } else {
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

  // 메인 필터(접수/작업중/지연) 는 상단 큰 요약카드 클릭. 휴지통만 별도의 작은 탭으로 유지.
  const filterTabs = [
    { key: "TRASH", label: "휴지통", count: trashOrders.length },
  ];

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
      setFeedback({ type: "error", msg: "완료된 요청만 휴지통으로 이동할 수 있습니다." });
      return;
    }
    if (!window.confirm(`"${order.orderNumber}" 요청을 휴지통으로 이동하시겠습니까?\n${TRASH_RETENTION_DAYS}일 후 자동 삭제되며, 그 전에 복원할 수 있습니다.`)) {
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
        throw new Error(errorBody.message || "휴지통 이동에 실패했습니다.");
      }

      setOrders((prev) => prev.filter((item) => item.id !== order.id));
      setTrashOrders((prev) => [
        { ...order, deletedAt: new Date().toISOString() },
        ...prev,
      ]);
      if (selectedOrderId === order.id) setSelectedOrderId(null);
      setFeedback({ type: "success", msg: "휴지통으로 이동했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "휴지통 이동 중 오류가 발생했습니다." });
    } finally {
      setTrashingOrderId(null);
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
      if (trashedIds.length > 0) parts.push(`완료·휴지통 이동 ${trashedIds.length}건`);
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

  const deletePermanently = async (order) => {
    if (!window.confirm(`"${order.orderNumber}" 요청을 영구 삭제하시겠습니까?\n첨부 파일까지 즉시 삭제되며 되돌릴 수 없습니다.`)) {
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
      setFeedback({ type: "success", msg: "영구 삭제했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "영구 삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingOrderId(null);
    }
  };

  const bulkPurgeTrash = async () => {
    if (trashOrders.length === 0) {
      setFeedback({ type: "error", msg: "휴지통이 비어 있습니다." });
      return;
    }
    if (!window.confirm(`휴지통의 ${trashOrders.length}건을 모두 영구 삭제하시겠습니까?\n첨부 파일까지 즉시 삭제되며 되돌릴 수 없습니다.`)) {
      return;
    }
    setBulkPurging(true);
    try {
      const results = await Promise.allSettled(
        trashOrders.map((order) =>
          fetch(`${BASE_URL}/api/admin/orders/${order.id}/permanent`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }).then((res) => {
            if (!res.ok) throw new Error(String(order.id));
            return order.id;
          })
        )
      );
      const deletedIds = new Set(
        results.filter((r) => r.status === "fulfilled").map((r) => r.value)
      );
      setTrashOrders((prev) => prev.filter((o) => !deletedIds.has(o.id)));
      if (selectedOrderId && deletedIds.has(selectedOrderId)) setSelectedOrderId(null);
      const failed = results.length - deletedIds.size;
      if (failed === 0) {
        setFeedback({ type: "success", msg: `${deletedIds.size}건을 영구 삭제했습니다.` });
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

  const requestLabel = (requestType) => REQUEST_TYPE_LABELS[requestType] || "요청";

  // 주문 카드 1건 렌더 — 카드 뷰와 달력 뷰(선택 일자 카드 영역) 양쪽에서 동일한 마크업 재사용.
  // 클로저로 활성 필터/선택모드/로딩 플래그/핸들러를 모두 캡처하므로 인자는 order 하나면 충분.
  const renderOrderCard = (order) => {
    const isTrash = activeFilter === "TRASH";
    const statusMeta = STATUS_META[order.status] || STATUS_META.RECEIVED;
    const nextStatus = getNextStatus(order.status);
    const updating = statusUpdatingId === order.id;
    const trashing = trashingOrderId === order.id;
    const restoring = restoringOrderId === order.id;
    const deleting = deletingOrderId === order.id;
    const daysLeft = isTrash ? daysLeftUntilPurge(order.deletedAt) : null;
    const viewedAt = order.adminViewedAt ? new Date(order.adminViewedAt).getTime() : 0;
    const evidenceAt = order.evidenceLastUploadedAt
      ? new Date(order.evidenceLastUploadedAt).getTime()
      : 0;
    const worksheetAt = order.worksheetUpdatedAt
      ? new Date(order.worksheetUpdatedAt).getTime()
      : 0;
    const hasNewEvidence = !isTrash && evidenceAt > viewedAt;
    const hasNewWorksheet = !isTrash && worksheetAt > viewedAt;
    const typeKey = order.requestType === "QUOTE" ? "quote" : "order";
    const isOrderType = order.requestType === "ORDER";
    return (
      <div
        key={order.id}
        className={`order-card order-card--${typeKey} ${isTrash ? "order-card--trash" : ""}`}
        onClick={() => setSelectedOrderId(order.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setSelectedOrderId(order.id);
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
            <span aria-hidden="true" />
            {isTrash ? (
              <span className="status-badge status-trash">
                {daysLeft === null ? "휴지통" : `${daysLeft}일 남음`}
              </span>
            ) : (
              <span className={`status-badge ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            )}
          </div>
          {(hasNewEvidence || hasNewWorksheet) && (
            <div className="order-card-thumb-badges">
              {hasNewEvidence && (
                <span className="row-badge badge-evidence" title="새 작업 사진이 올라왔습니다">사진</span>
              )}
              {hasNewWorksheet && (
                <span className="row-badge badge-worksheet" title="지시서/납기가 변경되었습니다">변경</span>
              )}
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
            <span className="order-card-num">{order.orderNumber}</span>
            <span className="order-card-date">
              {formatDateWithDay(isTrash ? order.deletedAt : order.createdAt)}
            </span>
          </div>

          <div className="order-card-actions" onClick={(e) => e.stopPropagation()}>
            {isTrash ? (
              <>
                <button
                  type="button"
                  className="next-status-btn action-restore"
                  onClick={() => restoreFromTrash(order)}
                  disabled={restoring || deleting}
                >
                  {restoring ? "복원 중..." : "복원"}
                </button>
                <button
                  type="button"
                  className="next-status-btn action-delete"
                  onClick={() => deletePermanently(order)}
                  disabled={deleting || restoring}
                >
                  {deleting ? "삭제 중..." : "영구삭제"}
                </button>
              </>
            ) : (
              <>
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
                    title="이미 완료 — 휴지통으로 이동"
                  >
                    {trashing ? "이동 중..." : "휴지통으로"}
                  </button>
                )}
              </>
            )}
          </div>
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
      </div>

      <div className="order-filter-tabs">
        {filterTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`filter-tab ${activeFilter === tab.key ? "active" : ""} ${tab.key === "TRASH" ? "trash-tab" : ""}`}
            onClick={() => setActiveFilter(tab.key)}
          >
            {tab.label}
            <span className="tab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      {activeFilter !== "TRASH" && (
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
                  ? "거래처 검색 — Enter 로 추가 (여러 곳 가능)"
                  : "거래처 추가..."
              }
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (clientSearch.trim()) {
                    addCalendarChip(clientSearch);
                    setClientSearch("");
                  }
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
            {calendarOrdersBase.filter((o) => !!o.dueDate).length}건
            {calendarOrdersBase.filter((o) => !o.dueDate).length > 0 &&
              ` / 납기 미정 ${calendarOrdersBase.filter((o) => !o.dueDate).length}건`}
          </span>
        </div>
      )}

      {/* 일괄 완료 검토 — overdue 가 있을 때 노출.
          접수 탭: 안 보임 (작업중에서 처리할 일).
          작업중 탭: 전체보기 모드일 때만 (단일 일자 작업 시엔 시야 방해 없게).
          지연 탭: 항상 (이 탭의 본 목적). */}
      {(
        (activeFilter === "OVERDUE" && overdueCount > 0) ||
        (activeFilter === "IN_PROGRESS" && isAllView && overdueCount > 0)
      ) && (
        <div className="bulk-action-row bulk-action-row--complete">
          <span className="bulk-action-text bulk-action-text--complete">
            완료 검토 대상 {overdueCount}건 · 한 건씩 PDF 보며 완료(휴지통) / 납기수정 결정
          </span>
          <button
            type="button"
            className="bulk-complete-btn"
            onClick={() => startBulkCompleteReview()}
            disabled={!!reviewSession}
          >
            {reviewSession ? "검토 중..." : "일괄 완료 검토"}
          </button>
        </div>
      )}
      {activeFilter === "TRASH" && trashOrders.length > 0 && (
        <div className="bulk-action-row">
          <span className="bulk-action-text">휴지통 {trashOrders.length}건</span>
          <button
            type="button"
            className="bulk-delete-btn"
            onClick={bulkPurgeTrash}
            disabled={bulkPurging}
          >
            {bulkPurging ? "삭제 중..." : "전부 영구삭제"}
          </button>
        </div>
      )}
      {activeFilter === "TRASH" && (
        <p className="trash-hint">
          휴지통의 항목은 삭제일로부터 {TRASH_RETENTION_DAYS}일 후 자동으로 영구 삭제됩니다.
        </p>
      )}

      {activeFilter === "TRASH" ? (
        <div className="order-card-view">
          {loading ? (
            <div className="order-empty">요청 목록을 불러오는 중입니다.</div>
          ) : trashOrders.length === 0 ? (
            <div className="order-empty">휴지통이 비어 있습니다.</div>
          ) : (
            <div className="order-card-grid">
              {trashOrders.map(renderOrderCard)}
            </div>
          )}
        </div>
      ) : (
        <div className="order-calendar-view">
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
            {(calendarClientChips.length > 0 || clientSearch.trim()) && (
              <span className="calendar-filter-pill">
                {calendarClientChips.length > 0
                  ? `필터: ${calendarClientChips.join(", ")}${clientSearch.trim() ? ` + ${clientSearch.trim()}` : ""}`
                  : `필터: ${clientSearch.trim()}`}
              </span>
            )}
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
              const badge = count > 0 && cell.currentMonth ? getDueBadge(key) : null;
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
                  aria-label={`${cell.date.getMonth() + 1}월 ${cell.date.getDate()}일${count > 0 ? `, 납기 ${count}건` : ""}`}
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
                    const badge = getDueBadge(selectedCalendarDate);
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
                    {calendarClientChips.length > 0 || clientSearch.trim()
                      ? "이 날짜에 해당 거래처 납기가 없습니다."
                      : "이 날짜에 납기가 없습니다."}
                  </div>
                ) : (
                  <div className="order-card-grid">
                    {calendarSelectedOrders.map(renderOrderCard)}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

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
                    휴지통 · {daysLeftUntilPurge(selectedOrder.deletedAt) ?? 0}일 남음
                  </span>
                ) : (
                  <span className={`status-badge ${(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).className}`}>
                    {(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).label}
                  </span>
                )}
                <div className="modal-status-actions">
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
                          {trashingOrderId === selectedOrder.id ? "이동 중..." : "휴지통으로"}
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
                      className={`review-choice ${reviewChoice === "complete" ? "active" : ""}`}
                      onClick={() => {
                        setReviewChoice("complete");
                        commitDecisionAndAdvance({ action: "complete" });
                      }}
                      title="실제로 납기가 지났음 — 완료로 처리"
                    >
                      <span className="review-choice-key">Enter</span>
                      <span className="review-choice-label">완료 처리</span>
                    </button>
                    <span className="review-arrow">→</span>
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
                      title="아직 안 지난 작업 — 납기를 새 날짜로 수정"
                    >
                      <span className="review-choice-key">→ Enter</span>
                      <span className="review-choice-label">납기 수정</span>
                    </button>
                  </div>
                ) : (
                  <div className="review-bar-mid review-bar-mid--date">
                    <span className="review-date-label">새 납기:</span>
                    <input
                      type="date"
                      className="review-date-input"
                      value={reviewDateInput}
                      onChange={(e) => setReviewDateInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!reviewDateInput) return;
                          commitDecisionAndAdvance({
                            action: "reschedule",
                            newDate: reviewDateInput,
                          });
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setReviewStage("choose");
                          setReviewChoice("reschedule");
                        }
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="review-confirm-btn"
                      disabled={!reviewDateInput}
                      onClick={() => {
                        commitDecisionAndAdvance({
                          action: "reschedule",
                          newDate: reviewDateInput,
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
    </div>
  );
}
