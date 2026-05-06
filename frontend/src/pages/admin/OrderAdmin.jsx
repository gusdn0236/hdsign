import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import PhotoLightbox from "../../components/common/PhotoLightbox.jsx";
import PdfViewer from "../../components/common/PdfViewer.jsx";
import WorksheetThumbnail from "../../components/common/WorksheetThumbnail.jsx";
import "./OrderAdmin.css";

const VIEW_MODE_KEY = "hdsign_admin_orders_view_mode";

function getStoredViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return v === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}
function setStoredViewMode(value) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, value);
  } catch { /* ignore */ }
}

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

// 카드 그리드의 납기 그룹 헤더 라벨 — 오늘/내일을 사람말로, 그 외엔 M월 D일 (요일).
function formatGroupLabel(dateStr) {
  if (!dateStr || dateStr === "none") return "납기 미정";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return dateStr;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const md = `${m}월 ${d}일`;
  const dow = WEEKDAY_KO[dt.getDay()];
  if (diffDays === 0) return `오늘 · ${md} (${dow})`;
  if (diffDays === 1) return `내일 · ${md} (${dow})`;
  if (diffDays < 0) return `지연 · ${md} (${dow})`;
  return `${md} (${dow})`;
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
// 이렇게 하면 statusCounts/summary/filteredOrders/bulk 액션 등 하위 로직이 자동으로 해당 유형
// 으로 좁혀져 분기 코드를 최소화할 수 있다.
export default function OrderAdmin({ requestType = "ORDER" }) {
  const { token } = useAuth();
  const isOrderPage = requestType === "ORDER";
  const pageTitle = isOrderPage ? "발주 관리" : "견적 관리";
  const [orders, setOrders] = useState([]);
  const [trashOrders, setTrashOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [activeFilter, setActiveFilter] = useState("ALL");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [pendingStatus, setPendingStatus] = useState("");
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const [trashingOrderId, setTrashingOrderId] = useState(null);
  const [restoringOrderId, setRestoringOrderId] = useState(null);
  const [deletingOrderId, setDeletingOrderId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [regeneratingHeaderId, setRegeneratingHeaderId] = useState(null);
  const [bulkTrashing, setBulkTrashing] = useState(false);
  const [bulkPurging, setBulkPurging] = useState(false);
  // 다중 선택 모드 — 행을 클릭하면 모달 대신 선택 토글. 선택한 건들은 한 번에 작업완료로.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkSelectCompleting, setBulkSelectCompleting] = useState(false);
  // 지연 일괄 완료 검토 — queue 의 주문 한 건씩 PDF 와 적용 납기를 보면서 결정한다.
  // decisions[id] = { action: 'complete' } 또는 { action: 'reschedule', newDate: 'yyyy-MM-dd' }.
  // 모든 주문을 다 보면 selectedOrderId 가 null 로 풀리고 상단 sticky 패널에서 일괄 적용.
  const [reviewSession, setReviewSession] = useState(null);
  const [reviewChoice, setReviewChoice] = useState("complete"); // 'complete' | 'reschedule'
  const [reviewStage, setReviewStage] = useState("choose"); // 'choose' | 'pickDate'
  const [reviewDateInput, setReviewDateInput] = useState("");
  const [bulkApplying, setBulkApplying] = useState(false);
  // QR 생성 패널 — 휴지통 탭 옆에서 펼쳐 거래처 한 번 고르면 빈 주문 + QR 클립보드.
  const [qrPanelOpen, setQrPanelOpen] = useState(false);
  const [qrPanelClients, setQrPanelClients] = useState([]);
  const [qrPanelQuery, setQrPanelQuery] = useState("");
  const [qrPanelSubmitting, setQrPanelSubmitting] = useState(false);
  const [qrPanelHighlight, setQrPanelHighlight] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [sortMode, setSortMode] = useState("DEFAULT");
  const [clientFilter, setClientFilter] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [dueDateRange, setDueDateRange] = useState("ALL");
  const [viewMode, setViewMode] = useState(() => getStoredViewMode());

  const switchViewMode = (mode) => {
    setViewMode(mode);
    setStoredViewMode(mode);
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
    if (!selectedOrder) {
      setPendingStatus("");
      return;
    }
    setPendingStatus(selectedOrder.status);
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

  useEffect(() => {
    setClientFilter("");
  }, [activeFilter]);

  // QR 패널 외부 클릭/ESC 닫기.
  useEffect(() => {
    if (!qrPanelOpen) return;
    const onDocClick = (ev) => {
      if (qrPanelSubmitting) return;
      const target = ev.target;
      if (target && target.closest && target.closest(".qr-panel-wrap")) return;
      setQrPanelOpen(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape" && !qrPanelSubmitting) setQrPanelOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [qrPanelOpen, qrPanelSubmitting]);

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

  const statusFilteredOrders = useMemo(() => {
    if (activeFilter === "TRASH") return trashOrders;
    if (activeFilter === "ALL") return orders;
    return orders.filter((order) => order.status === activeFilter);
  }, [activeFilter, orders, trashOrders]);

  const availableClients = useMemo(() => {
    const set = new Set();
    statusFilteredOrders.forEach((o) => {
      if (o.clientCompanyName) set.add(o.clientCompanyName);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [statusFilteredOrders]);

  const filteredOrders = useMemo(() => {
    if (activeFilter === "TRASH") return statusFilteredOrders;

    let result = [...statusFilteredOrders];

    const searchTerm = clientSearch.trim().toLowerCase();
    if (searchTerm) {
      result = result.filter((o) =>
        (o.clientCompanyName || "").toLowerCase().includes(searchTerm)
      );
    }

    if (sortMode === "BY_CLIENT") {
      if (clientFilter) {
        result = result.filter((o) => (o.clientCompanyName || "") === clientFilter);
      }
      result.sort((a, b) => {
        const ca = a.clientCompanyName || "";
        const cb = b.clientCompanyName || "";
        if (ca === cb) {
          const da = a.dueDate ? String(a.dueDate).split("T")[0] : "";
          const db = b.dueDate ? String(b.dueDate).split("T")[0] : "";
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return da.localeCompare(db);
        }
        return ca.localeCompare(cb, "ko");
      });
    } else if (sortMode === "BY_DUE_DATE") {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekEndStr = `${weekEnd.getFullYear()}-${pad(weekEnd.getMonth() + 1)}-${pad(weekEnd.getDate())}`;

      if (dueDateRange === "TODAY") {
        result = result.filter((o) => o.dueDate && String(o.dueDate).split("T")[0] === today);
      } else if (dueDateRange === "WEEK") {
        result = result.filter((o) => {
          if (!o.dueDate) return false;
          const d = String(o.dueDate).split("T")[0];
          return d >= today && d <= weekEndStr;
        });
      } else if (dueDateRange === "OVERDUE") {
        result = result.filter((o) => {
          if (!o.dueDate) return false;
          return String(o.dueDate).split("T")[0] < today && o.status !== "COMPLETED";
        });
      }
      result.sort((a, b) => {
        const da = a.dueDate ? String(a.dueDate).split("T")[0] : "";
        const db = b.dueDate ? String(b.dueDate).split("T")[0] : "";
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.localeCompare(db);
      });
    }

    return result;
  }, [statusFilteredOrders, sortMode, clientFilter, clientSearch, dueDateRange, activeFilter]);

  // 카드 보기 — 납기별 정렬일 때만 dueDate 로 그룹핑(모바일 /m/worksheets 와 동일).
  // 그 외 모드(기본/거래처별/휴지통)에선 단일 그룹 한 덩어리로 보여 시각적 산만함을 줄인다.
  const cardGroups = useMemo(() => {
    const useDateGroups = activeFilter !== "TRASH" && sortMode === "BY_DUE_DATE";
    if (!useDateGroups) {
      return [{ key: "_all", label: null, list: filteredOrders }];
    }
    const map = new Map();
    filteredOrders.forEach((o) => {
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
      .map(([key, list]) => ({ key, label: formatGroupLabel(key), list }));
  }, [filteredOrders, sortMode, activeFilter]);

  const currentOrderIndex = useMemo(() => {
    if (!selectedOrderId) return -1;
    return filteredOrders.findIndex((o) => o.id === selectedOrderId);
  }, [filteredOrders, selectedOrderId]);

  const hasPrevOrder = currentOrderIndex > 0;
  const hasNextOrder = currentOrderIndex >= 0 && currentOrderIndex < filteredOrders.length - 1;
  const goToPrevOrder = () => {
    if (hasPrevOrder) setSelectedOrderId(filteredOrders[currentOrderIndex - 1].id);
  };
  const goToNextOrder = () => {
    if (hasNextOrder) setSelectedOrderId(filteredOrders[currentOrderIndex + 1].id);
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
  }, [selectedOrderId, lightboxIndex, currentOrderIndex, filteredOrders, reviewSession, reviewStage, reviewChoice, orders]);

  const filterTabs = [
    { key: "ALL", label: "전체", count: orders.length },
    { key: "RECEIVED", label: STATUS_META.RECEIVED.label, count: statusCounts.RECEIVED },
    { key: "IN_PROGRESS", label: STATUS_META.IN_PROGRESS.label, count: statusCounts.IN_PROGRESS },
    { key: "COMPLETED", label: STATUS_META.COMPLETED.label, count: statusCounts.COMPLETED },
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

  const bulkMoveCompletedToTrash = async () => {
    const completed = orders.filter((o) => o.status === "COMPLETED");
    if (completed.length === 0) {
      setFeedback({ type: "error", msg: "휴지통으로 이동할 완료 요청이 없습니다." });
      return;
    }
    if (!window.confirm(`완료 요청 ${completed.length}건을 모두 휴지통으로 이동하시겠습니까?\n${TRASH_RETENTION_DAYS}일 후 자동 삭제되며, 그 전에 복원할 수 있습니다.`)) {
      return;
    }
    setBulkTrashing(true);
    try {
      const results = await Promise.allSettled(
        completed.map((order) =>
          fetch(`${BASE_URL}/api/admin/orders/${order.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }).then((res) => {
            if (!res.ok) throw new Error(String(order.id));
            return order;
          })
        )
      );
      const moved = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const movedIds = new Set(moved.map((o) => o.id));
      const now = new Date().toISOString();
      setOrders((prev) => prev.filter((o) => !movedIds.has(o.id)));
      setTrashOrders((prev) => [
        ...moved.map((o) => ({ ...o, deletedAt: now })),
        ...prev,
      ]);
      if (selectedOrderId && movedIds.has(selectedOrderId)) setSelectedOrderId(null);
      const failed = results.length - moved.length;
      if (failed === 0) {
        setFeedback({ type: "success", msg: `${moved.length}건을 휴지통으로 이동했습니다.` });
      } else {
        setFeedback({ type: "error", msg: `${moved.length}건 이동, ${failed}건 실패` });
      }
    } finally {
      setBulkTrashing(false);
    }
  };

  // 다중 선택 — 한 건 토글, 모드 진입/종료, 일괄 작업완료.
  const toggleSelectId = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };
  const selectAllVisible = () => {
    setSelectedIds(new Set(filteredOrders.map((o) => o.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const completeSelected = async () => {
    if (selectedIds.size === 0 || bulkSelectCompleting) return;
    if (!window.confirm(`선택한 ${selectedIds.size}건을 모두 작업완료로 변경하시겠습니까?`)) return;
    setBulkSelectCompleting(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${BASE_URL}/api/admin/orders/${id}/status`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ status: "COMPLETED" }),
          }).then(async (res) => {
            if (!res.ok) throw new Error(String(id));
            return res.json();
          })
        )
      );
      const updated = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const updatedMap = new Map(updated.map((o) => [o.id, o]));
      setOrders((prev) => prev.map((o) => updatedMap.get(o.id) || o));
      const failed = results.length - updated.length;
      setFeedback({
        type: failed === 0 ? "success" : "error",
        msg: failed === 0
          ? `${updated.length}건을 작업완료 처리했습니다.`
          : `${updated.length}건 완료, ${failed}건 실패`,
      });
      exitSelectMode();
    } finally {
      setBulkSelectCompleting(false);
    }
  };

  // 지연 검토 시작 — 일괄 완료 버튼을 누르면 한 건씩 PDF 를 보면서 결정한다.
  // 적용 납기가 지났지만 실제로는 미래 작업인 케이스(웹 적용 누락)를 한 번 더 거르기 위함.
  const startBulkCompleteReview = () => {
    if (selectMode) exitSelectMode();
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const overdue = orders.filter(
      (o) =>
        o.dueDate &&
        String(o.dueDate).split("T")[0] < today &&
        o.status !== "COMPLETED"
    );
    if (overdue.length === 0) {
      setFeedback({ type: "error", msg: "지연된 요청이 없습니다." });
      return;
    }
    setReviewSession({
      queue: overdue.map((o) => o.id),
      cursor: 0,
      decisions: {},
    });
    setReviewChoice("complete");
    setReviewStage("choose");
    setReviewDateInput("");
    setSelectedOrderId(overdue[0].id);
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

  // 모든 검토가 끝난 뒤 "일괄 적용" — 완료 처리는 PUT /status, 납기 수정은 PUT /due-date.
  // 둘 다 병렬로 보내고 결과를 합쳐서 한 번에 피드백.
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

      const completePromises = completeIds.map((id) =>
        fetch(`${BASE_URL}/api/admin/orders/${id}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: "COMPLETED" }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(String(id));
          return res.json();
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

      const results = await Promise.allSettled([...completePromises, ...reschedulePromises]);
      const updated = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      const failed = results.length - updated.length;
      const updatedMap = new Map(updated.map((o) => [o.id, o]));
      setOrders((prev) => prev.map((o) => updatedMap.get(o.id) || o));

      const completedOk = updated.filter((o) => o.status === "COMPLETED" && completeIds.includes(o.id)).length;
      const rescheduledOk = updated.length - completedOk;
      const parts = [];
      if (completedOk > 0) parts.push(`완료 ${completedOk}건`);
      if (rescheduledOk > 0) parts.push(`납기 수정 ${rescheduledOk}건`);
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

  // 자동지시서작성이 RPC 타임아웃 등으로 실패해 거래처 원본만 받아진 경우의 폴백.
  // 헤더(QR + 박스 + 좌측텍스트 + 노트박스) 만 그린 작은 AI 를 워처가 만들어 FlexSign 에 띄움.
  // 사용자는 그 헤더를 복사해 거래처 원본 캔버스에 붙여 인쇄 → PDF24 → 매칭 으로 동일 흐름 복귀.
  // QR 은 같은 /p/{orderNumber} 를 가리키므로 재생성 후에도 작업 추적은 정상.
  const regenerateHeader = async (e, order) => {
    e.stopPropagation();
    setRegeneratingHeaderId(order.id);
    try {
      const watcherUp = await isWatcherRunning();
      if (!watcherUp) {
        setFeedback({
          type: "error",
          msg: "지시서 프로그램이 실행 중이지 않습니다. 프로그램을 켠 뒤 다시 시도해 주세요.",
        });
        return;
      }
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}/worksheet-header-package`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("헤더 생성 실패");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${order.orderNumber}_지시서_헤더만.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFeedback({
        type: "success",
        msg: "헤더 ZIP을 다운받았습니다. FlexSign에서 헤더를 복사해 거래처 원본에 붙여 인쇄해주세요.",
      });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "QR재생성 중 오류가 발생했습니다." });
    } finally {
      setRegeneratingHeaderId(null);
    }
  };

  // 수동 작성 지시서용 QR 생성 — 거래처 한 번 고르면 빈 주문(번호만 부여)이 DB 에 만들어지고,
  // 워처가 EMF(벡터) QR + 주문번호를 Windows 클립보드에 올린다. 사용자는 FlexSign .fs 캔버스에
  // Ctrl+V → 인쇄 → PDF24 → 매칭 다이얼로그가 이 주문에 자동 매칭하면서 납기/배송을 입력받음.
  const openQrPanel = async () => {
    setQrPanelOpen(true);
    setQrPanelQuery("");
    setQrPanelHighlight(0);
    if (qrPanelClients.length > 0) return;
    try {
      const res = await fetch(`${BASE_URL}/api/admin/clients`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("거래처 목록을 불러오지 못했습니다.");
      const data = await res.json();
      const selectable = (Array.isArray(data) ? data : []).filter(
        (c) => c.status === "ACTIVE" || c.status === "PENDING_SIGNUP"
      );
      setQrPanelClients(selectable);
    } catch (err) {
      setFeedback({ type: "error", msg: err.message });
    }
  };

  const closeQrPanel = () => {
    if (qrPanelSubmitting) return;
    setQrPanelOpen(false);
    setQrPanelQuery("");
  };

  const qrPanelSuggestions = useMemo(() => {
    const q = qrPanelQuery.trim().toLowerCase();
    const sorted = [...qrPanelClients].sort((a, b) =>
      (a.companyName || "").localeCompare(b.companyName || "", "ko")
    );
    if (!q) return sorted.slice(0, 20);
    return sorted
      .filter((c) => {
        const hay = `${c.companyName || ""} ${c.networkFolderName || ""} ${c.aliases || ""} ${c.contactName || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 20);
  }, [qrPanelQuery, qrPanelClients]);

  const handleQrPanelPick = async (client) => {
    if (!client || qrPanelSubmitting) return;
    setQrPanelSubmitting(true);
    try {
      const watcherUp = await isWatcherRunning();
      if (!watcherUp) {
        setFeedback({
          type: "error",
          msg: "지시서 프로그램이 실행 중이지 않습니다. 프로그램을 켠 뒤 다시 시도해 주세요.",
        });
        return;
      }
      // 1) 빈 주문 생성 — clientId 만 보내면 백엔드가 주문번호 발번.
      const fd = new URLSearchParams();
      fd.append("clientId", String(client.id));
      const createRes = await fetch(`${BASE_URL}/api/admin/orders/qr-only`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: fd.toString(),
      });
      if (!createRes.ok) throw new Error("주문 생성에 실패했습니다.");
      const created = await createRes.json();
      const orderNumber = created.orderNumber;
      const company = created.clientCompanyName || client.companyName || "";

      // 2) 워처에게 QR EMF 클립보드 + 인쇄 매칭 큐 등록 요청.
      const url = `http://127.0.0.1:5577/clip-qr?order=${encodeURIComponent(orderNumber)}&company=${encodeURIComponent(company)}`;
      const clipRes = await fetch(url, { method: "POST" });
      if (!clipRes.ok) {
        let msg = "QR 클립보드 복사에 실패했습니다.";
        try {
          const j = await clipRes.json();
          if (j && j.error) msg = `QR 클립보드 복사 실패: ${j.error}`;
        } catch { /* ignore */ }
        throw new Error(msg);
      }

      // 3) UI 정리 + 주문 목록 새로고침(새 주문이 카드에 즉시 보이도록).
      setFeedback({
        type: "success",
        msg: `${orderNumber} (${company}) QR 이 클립보드에 복사되었습니다. FlexSign 캔버스에서 Ctrl+V → 인쇄하세요.`,
      });
      setQrPanelOpen(false);
      setQrPanelQuery("");
      loadOrders();
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "QR 생성 중 오류가 발생했습니다." });
    } finally {
      setQrPanelSubmitting(false);
    }
  };

  const requestLabel = (requestType) => REQUEST_TYPE_LABELS[requestType] || "요청";

  return (
    <div className="order-admin-page">
      {feedback && <div className={`order-feedback ${feedback.type}`}>{feedback.msg}</div>}

      <div className="order-summary">
        <div className="summary-card summary-received">
          <span className="summary-count">{statusCounts.RECEIVED}</span>
          <span className="summary-label">접수</span>
        </div>
        <div className="summary-card summary-in-progress">
          <span className="summary-count">{statusCounts.IN_PROGRESS}</span>
          <span className="summary-label">작업중</span>
        </div>
        <div className="summary-card summary-completed">
          <span className="summary-count">{statusCounts.COMPLETED}</span>
          <span className="summary-label">완료</span>
        </div>
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
        {isOrderPage && (
          <div className="qr-panel-wrap">
            <button
              type="button"
              className="filter-tab qr-trigger"
              onClick={() => (qrPanelOpen ? closeQrPanel() : openQrPanel())}
              title="이미 그려놓은 지시서에 덧붙일 QR + 주문번호만 클립보드에 벡터로 복사"
            >
              기존지시서에 QR코드만 생성
            </button>
            {qrPanelOpen && (
              <div className="qr-panel" onClick={(e) => e.stopPropagation()}>
                <div className="qr-panel-head">
                  <span className="qr-panel-title">거래처 선택</span>
                  <button
                    type="button"
                    className="qr-panel-close"
                    onClick={closeQrPanel}
                    disabled={qrPanelSubmitting}
                    aria-label="닫기"
                  >×</button>
                </div>
                <input
                  type="text"
                  className="qr-panel-input"
                  placeholder="거래처명/별칭/담당자 검색"
                  value={qrPanelQuery}
                  onChange={(e) => {
                    setQrPanelQuery(e.target.value);
                    setQrPanelHighlight(0);
                  }}
                  onKeyDown={(e) => {
                    if (qrPanelSubmitting) return;
                    const max = qrPanelSuggestions.length - 1;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setQrPanelHighlight((i) => Math.min(i + 1, max));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setQrPanelHighlight((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const c = qrPanelSuggestions[qrPanelHighlight];
                      if (c) handleQrPanelPick(c);
                    }
                  }}
                  disabled={qrPanelSubmitting}
                  autoFocus
                />
                <div className="qr-panel-list">
                  {qrPanelSuggestions.length === 0 ? (
                    <div className="qr-panel-empty">
                      {qrPanelClients.length === 0 ? "거래처를 불러오는 중..." : "검색 결과 없음"}
                    </div>
                  ) : (
                    qrPanelSuggestions.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`qr-panel-row ${idx === qrPanelHighlight ? "highlight" : ""}`}
                        onClick={() => handleQrPanelPick(c)}
                        onMouseEnter={() => setQrPanelHighlight(idx)}
                        disabled={qrPanelSubmitting}
                        ref={(el) => {
                          if (el && idx === qrPanelHighlight) {
                            el.scrollIntoView({ block: "nearest" });
                          }
                        }}
                      >
                        <span className="qr-panel-row-name">{c.companyName}</span>
                        {c.contactName && (
                          <span className="qr-panel-row-sub">{c.contactName}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                {qrPanelSubmitting && (
                  <div className="qr-panel-submitting">QR 만드는 중...</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="order-sort-row">
        {activeFilter !== "TRASH" && (
          <>
            <div className="sort-buttons">
              <button
                type="button"
                className={`sort-btn ${sortMode === "DEFAULT" ? "active" : ""}`}
                onClick={() => {
                  setSortMode("DEFAULT");
                  setClientFilter("");
                  setClientSearch("");
                  setDueDateRange("ALL");
                }}
              >
                기본
              </button>
              <button
                type="button"
                className={`sort-btn ${sortMode === "BY_CLIENT" ? "active" : ""}`}
                onClick={() => setSortMode("BY_CLIENT")}
              >
                거래처별
              </button>
              <button
                type="button"
                className={`sort-btn ${sortMode === "BY_DUE_DATE" ? "active" : ""}`}
                onClick={() => setSortMode("BY_DUE_DATE")}
              >
                납기별
              </button>
            </div>
            <div className="client-search-box">
              <input
                type="search"
                className="client-search-input"
                placeholder="거래처 검색"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
              />
              {clientSearch && (
                <button
                  type="button"
                  className="client-search-clear"
                  onClick={() => setClientSearch("")}
                  aria-label="검색어 지우기"
                  title="지우기"
                >
                  ×
                </button>
              )}
            </div>
            {sortMode === "BY_CLIENT" && (
              <select
                className="sort-select"
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
              >
                <option value="">전체 거래처 (이름순)</option>
                {availableClients.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            )}
            {sortMode === "BY_DUE_DATE" && (
              <select
                className="sort-select"
                value={dueDateRange}
                onChange={(e) => setDueDateRange(e.target.value)}
              >
                <option value="ALL">전체 (가까운 납기순)</option>
                <option value="TODAY">오늘 납기</option>
                <option value="WEEK">7일 이내</option>
                <option value="OVERDUE">지연 (완료 제외)</option>
              </select>
            )}
            {(sortMode !== "DEFAULT" || clientSearch.trim()) && (
              <span className="sort-result-count">{filteredOrders.length}건</span>
            )}
          </>
        )}
        {activeFilter !== "TRASH" && !reviewSession && (
          <button
            type="button"
            className={`select-mode-toggle ${selectMode ? "active" : ""}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            title={selectMode ? "선택 모드 종료" : "여러 건 선택해 한 번에 작업완료"}
          >
            {selectMode ? "선택 모드 끄기" : "여러개 선택"}
          </button>
        )}
        <div className="view-mode-toggle">
          <button
            type="button"
            className={`view-mode-btn ${viewMode === "table" ? "active" : ""}`}
            onClick={() => switchViewMode("table")}
            title="표 보기"
            aria-label="표 보기"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M2 7h12M2 10h12M6 3v10" />
            </svg>
            <span>표</span>
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === "cards" ? "active" : ""}`}
            onClick={() => switchViewMode("cards")}
            title="카드 보기"
            aria-label="카드 보기"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="2" y="2" width="5.5" height="5.5" rx="1" />
              <rect x="8.5" y="2" width="5.5" height="5.5" rx="1" />
              <rect x="2" y="8.5" width="5.5" height="5.5" rx="1" />
              <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" />
            </svg>
            <span>카드</span>
          </button>
        </div>
      </div>

      {activeFilter === "COMPLETED" && statusCounts.COMPLETED > 0 && (
        <div className="bulk-action-row">
          <span className="bulk-action-text">완료 요청 {statusCounts.COMPLETED}건</span>
          <button
            type="button"
            className="bulk-delete-btn"
            onClick={bulkMoveCompletedToTrash}
            disabled={bulkTrashing}
          >
            {bulkTrashing ? "이동 중..." : "전부 휴지통으로 보내기"}
          </button>
        </div>
      )}
      {activeFilter !== "TRASH" && sortMode === "BY_DUE_DATE" && dueDateRange === "OVERDUE" && filteredOrders.length > 0 && (
        <div className="bulk-action-row bulk-action-row--complete">
          <span className="bulk-action-text bulk-action-text--complete">
            지연 요청 {filteredOrders.length}건 · 한 건씩 보면서 완료/납기수정 결정
          </span>
          <button
            type="button"
            className="bulk-complete-btn"
            onClick={startBulkCompleteReview}
            disabled={!!reviewSession}
          >
            {reviewSession ? "검토 중..." : "지연 검토 시작"}
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

      {viewMode === "table" ? (
      <table className="order-admin-table">
        <thead>
          <tr>
            {selectMode && (() => {
              const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every((o) => selectedIds.has(o.id));
              const someFilteredSelected = !allFilteredSelected && filteredOrders.some((o) => selectedIds.has(o.id));
              return (
                <th className="order-select-cell" aria-label="선택">
                  <input
                    type="checkbox"
                    className="order-select-checkbox"
                    checked={allFilteredSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someFilteredSelected;
                    }}
                    onChange={(e) => (e.target.checked ? selectAllVisible() : clearSelection())}
                    aria-label="현재 화면 전체 선택"
                  />
                </th>
              );
            })()}
            <th>요청번호</th>
            <th>거래처</th>
            <th>제목</th>
            {isOrderPage && <th>납기</th>}
            <th>{activeFilter === "TRASH" ? "남은 일수" : "상태"}</th>
            <th>{activeFilter === "TRASH" ? "삭제일" : "등록일"}</th>
            <th>상태변경</th>
            {isOrderPage && <th>프로그램실행</th>}
          </tr>
        </thead>
        <tbody>
          {(() => {
            const baseCols = isOrderPage ? 8 : 6;
            const colSpan = selectMode ? baseCols + 1 : baseCols;
            return loading ? (
            <tr>
              <td colSpan={colSpan} className="order-empty">요청 목록을 불러오는 중입니다.</td>
            </tr>
          ) : filteredOrders.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="order-empty">
                {activeFilter === "TRASH" ? "휴지통이 비어 있습니다." : "표시할 요청이 없습니다."}
              </td>
            </tr>
          ) : (
            filteredOrders.map((order) => {
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
              // 변경 배지: worksheetUpdatedAt 가 마지막 관리자 열람보다 늦을 때만 노출.
              // worksheetChangeNote 는 워처 다이얼로그에서 다음 회차에 prefill 하기 위해 영속되므로
              // "노트 존재"만으로 배지를 트리거하면 한 번 변경 노트가 생긴 주문은 영구히 배지가 남는다.
              // 관리자가 한 번 보면 깨끗이 사라지고, 새 변경으로 타임스탬프가 갱신될 때만 다시 뜸.
              const hasNewWorksheet = !isTrash && worksheetAt > viewedAt;

              const typeKey = order.requestType === "QUOTE" ? "quote" : "order";
              const isSelected = selectMode && selectedIds.has(order.id);
              const handleRowActivate = () => {
                if (selectMode) toggleSelectId(order.id);
                else setSelectedOrderId(order.id);
              };
              return (
                <tr
                  key={order.id}
                  className={`order-row ${isTrash ? "trash-row" : ""} order-row--${typeKey} ${isSelected ? "order-row--selected" : ""}`}
                  onClick={handleRowActivate}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRowActivate();
                    }
                  }}
                >
                  {selectMode && (
                    <td className="order-select-cell" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="order-select-checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectId(order.id)}
                        aria-label={`${order.orderNumber} 선택`}
                      />
                    </td>
                  )}
                  <td className="order-num">
                    <span className="order-num-text">{order.orderNumber}</span>
                    {(hasNewEvidence || hasNewWorksheet) && (
                      <span className="row-badges">
                        {hasNewEvidence && (
                          <span className="row-badge badge-evidence" title="새 작업 사진이 올라왔습니다">
                            사진
                          </span>
                        )}
                        {hasNewWorksheet && (
                          <span className="row-badge badge-worksheet" title="지시서/납기가 변경되었습니다">
                            변경
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{order.clientCompanyName || "-"}</td>
                  <td className="order-title">{order.title || requestLabel(order.requestType)}</td>
                  {isOrderPage && <td>{formatDueDate(order.dueDate, order.deliveryMethod)}</td>}
                  <td>
                    {isTrash ? (
                      <span className="status-badge status-trash">
                        {daysLeft === null ? "-" : `${daysLeft}일 남음`}
                      </span>
                    ) : (
                      <span className={`status-badge ${statusMeta.className}`}>{statusMeta.label}</span>
                    )}
                  </td>
                  <td>{formatDateWithDay(isTrash ? order.deletedAt : order.createdAt)}</td>
                  <td>
                    {isTrash ? (
                      <div className="trash-actions">
                        <button
                          type="button"
                          className="next-status-btn action-restore"
                          onClick={(e) => {
                            e.stopPropagation();
                            restoreFromTrash(order);
                          }}
                          disabled={restoring || deleting}
                        >
                          {restoring ? "복원 중..." : "복원"}
                        </button>
                        <button
                          type="button"
                          className="next-status-btn action-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deletePermanently(order);
                          }}
                          disabled={deleting || restoring}
                        >
                          {deleting ? "삭제 중..." : "영구삭제"}
                        </button>
                      </div>
                    ) : !nextStatus ? (
                      <button
                        type="button"
                        className="next-status-btn action-trash"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveCompletedToTrash(order);
                        }}
                        disabled={trashing}
                      >
                        {trashing ? "이동 중..." : "휴지통으로"}
                      </button>
                    ) : order.status === "RECEIVED" && order.requestType === "ORDER" ? (
                      // ORDER 의 RECEIVED 는 [지시서 자동작성하기] 로만 진행 — 수동 상태변경은 제공 안 함.
                      null
                    ) : (
                      <button
                        type="button"
                        className={`next-status-btn ${order.status === "RECEIVED" ? "action-start" : "action-complete"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateOrderStatus(order.id, nextStatus);
                        }}
                        disabled={updating || selectMode}
                        title={selectMode ? "선택 모드 종료 후 사용 가능 (선택 모드는 하단 [작업완료] 로 일괄 처리)" : undefined}
                      >
                        {updating
                          ? "변경 중..."
                          : order.status === "IN_PROGRESS"
                            ? "작업완료처리"
                            : "다음 단계"}
                      </button>
                    )}
                  </td>
                  {isOrderPage && (
                    <td>
                      {/* 파일이 0 개이면 [기존지시서에 QR코드만 생성] 으로 만든 빈 주문 — 자동지시서작성 대상 아님.
                          IN_PROGRESS 단계의 [QR재생성] 은 잘 안 쓰는 폴백이라 행에선 숨기고 모달에서만 노출. */}
                      {!isTrash && nextStatus && order.status === "RECEIVED" && (order.files?.length ?? 0) > 0 ? (
                        <button
                          type="button"
                          className="next-status-btn action-worksheet"
                          onClick={(e) => downloadWorksheet(e, order)}
                          disabled={downloadingId === order.id}
                        >
                          {downloadingId === order.id ? "준비 중..." : "지시서 자동작성하기"}
                        </button>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })
          );
          })()}
        </tbody>
      </table>
      ) : (
        <div className="order-card-view">
          {loading ? (
            <div className="order-empty">요청 목록을 불러오는 중입니다.</div>
          ) : filteredOrders.length === 0 ? (
            <div className="order-empty">
              {activeFilter === "TRASH" ? "휴지통이 비어 있습니다." : "표시할 요청이 없습니다."}
            </div>
          ) : (
            cardGroups.map((group) => (
              <section className="order-card-group" key={group.key}>
                {group.label && (
                  <h2 className="order-card-group-head">
                    <span>{group.label}</span>
                    <span className="order-card-group-count">{group.list.length}건</span>
                  </h2>
                )}
                <div className="order-card-grid">
                  {group.list.map((order) => {
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

                    const isSelectedCard = selectMode && selectedIds.has(order.id);
                    const handleCardActivate = () => {
                      if (selectMode) toggleSelectId(order.id);
                      else setSelectedOrderId(order.id);
                    };
                    return (
                      <div
                        key={order.id}
                        className={`order-card order-card--${typeKey} ${isTrash ? "order-card--trash" : ""} ${isSelectedCard ? "order-card--selected" : ""}`}
                        onClick={handleCardActivate}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleCardActivate();
                          }
                        }}
                      >
                        {selectMode && (
                          <div
                            className="order-card-select-mark"
                            aria-hidden="true"
                          >
                            <span className={`order-card-select-box ${isSelectedCard ? "checked" : ""}`}>
                              {isSelectedCard ? "✓" : ""}
                            </span>
                          </div>
                        )}
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
                            <span className="order-card-due">
                              {formatDueDate(order.dueDate, order.deliveryMethod)}
                            </span>
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
                                {/* 파일 없는 주문(QR-only) 은 자동지시서작성 대상 아님 — 버튼 숨김. */}
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
                                {/* IN_PROGRESS 의 [QR재생성] 은 잘 안 쓰는 폴백 — 카드에선 숨기고 모달에서만 노출. */}
                                {nextStatus && !(isOrderType && order.status === "RECEIVED") && (
                                  <button
                                    type="button"
                                    className={`next-status-btn ${order.status === "RECEIVED" ? "action-start" : "action-complete"}`}
                                    onClick={() => updateOrderStatus(order.id, nextStatus)}
                                    disabled={updating || selectMode}
                                    title={selectMode ? "선택 모드 종료 후 사용 가능 (하단 [작업완료] 로 일괄 처리)" : undefined}
                                  >
                                    {updating
                                      ? "변경 중..."
                                      : order.status === "IN_PROGRESS"
                                        ? "작업완료"
                                        : "다음 단계"}
                                  </button>
                                )}
                                {!nextStatus && (
                                  <button
                                    type="button"
                                    className="next-status-btn action-trash"
                                    onClick={() => moveCompletedToTrash(order)}
                                    disabled={trashing}
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
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      <PhotoLightbox
        photos={evidencePhotos}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndexChange={setLightboxIndex}
      />

      {selectMode && (() => {
        const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every((o) => selectedIds.has(o.id));
        return (
        <div className="select-bar" role="region" aria-label="선택 모드">
          <span className="select-bar-count">
            <strong>{selectedIds.size}</strong>건 선택 / {filteredOrders.length}건
          </span>
          <div className="select-bar-actions">
            <button
              type="button"
              className="select-bar-btn select-bar-btn--ghost"
              onClick={allFilteredSelected ? clearSelection : selectAllVisible}
              disabled={filteredOrders.length === 0}
            >
              {allFilteredSelected ? "선택 해제" : "현재 화면 전체 선택"}
            </button>
            <button
              type="button"
              className="select-bar-btn select-bar-btn--primary"
              onClick={completeSelected}
              disabled={selectedIds.size === 0 || bulkSelectCompleting}
            >
              {bulkSelectCompleting ? "처리 중..." : `작업완료 (${selectedIds.size})`}
            </button>
            <button
              type="button"
              className="select-bar-btn select-bar-btn--ghost"
              onClick={exitSelectMode}
              disabled={bulkSelectCompleting}
            >
              종료
            </button>
          </div>
        </div>
        );
      })()}

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
                  {currentOrderIndex >= 0 && filteredOrders.length > 1 && (
                    <span className="modal-order-nav-position">
                      {currentOrderIndex + 1} / {filteredOrders.length}
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
                      {/* 파일 없는 주문(QR-only) 은 자동지시서작성 대상 아님. */}
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
                      {selectedOrder.status === "IN_PROGRESS" && selectedOrder.requestType === "ORDER" && (
                        <button
                          type="button"
                          className="next-status-btn action-worksheet"
                          disabled={regeneratingHeaderId === selectedOrder.id}
                          onClick={(e) => regenerateHeader(e, selectedOrder)}
                          title="자동지시서작성이 실패해 거래처 파일만 받아졌을 때, QR 헤더(QR+주문정보) 만 다시 생성"
                        >
                          {regeneratingHeaderId === selectedOrder.id ? "준비 중..." : "QR재생성"}
                        </button>
                      )}
                      <select
                        value={pendingStatus || selectedOrder.status}
                        onChange={(e) => setPendingStatus(e.target.value)}
                        disabled={statusUpdatingId === selectedOrder.id}
                      >
                        {STATUS_ORDER.map((statusKey) => (
                          <option key={statusKey} value={statusKey}>
                            {STATUS_META[statusKey].label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="next-status-btn action-start"
                        disabled={
                          statusUpdatingId === selectedOrder.id ||
                          !pendingStatus ||
                          pendingStatus === selectedOrder.status
                        }
                        onClick={() => updateOrderStatus(selectedOrder.id, pendingStatus)}
                      >
                        {statusUpdatingId === selectedOrder.id ? "변경 중..." : "상태 변경"}
                      </button>
                      {selectedOrder.status === "COMPLETED" && (
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
