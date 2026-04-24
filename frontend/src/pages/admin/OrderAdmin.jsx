import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import "./OrderAdmin.css";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

const STATUS_META = {
  RECEIVED: { label: "접수완료", className: "status-received" },
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
};

const REQUEST_TYPE_LABELS = {
  ORDER: "작업 요청",
  QUOTE: "견적 요청",
};

function formatDate(value) {
  if (!value) return "-";
  return String(value).split("T")[0];
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

export default function OrderAdmin() {
  const { token } = useAuth();
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
  const [bulkTrashing, setBulkTrashing] = useState(false);
  const [bulkPurging, setBulkPurging] = useState(false);

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
      setOrders(Array.isArray(activeData) ? activeData : []);
      setTrashOrders(Array.isArray(trashData) ? trashData : []);
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "주문 목록 조회 중 오류가 발생했습니다." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadOrders();
  }, [token]);

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

  useEffect(() => {
    if (!selectedOrder) {
      setPendingStatus("");
      return;
    }
    setPendingStatus(selectedOrder.status);
  }, [selectedOrder]);

  const statusCounts = useMemo(() => {
    const counts = { RECEIVED: 0, IN_PROGRESS: 0, COMPLETED: 0 };
    orders.forEach((order) => {
      if (counts[order.status] !== undefined) counts[order.status] += 1;
    });
    return counts;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (activeFilter === "TRASH") return trashOrders;
    if (activeFilter === "ALL") return orders;
    return orders.filter((order) => order.status === activeFilter);
  }, [activeFilter, orders, trashOrders]);

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

  const downloadWorksheet = async (e, order) => {
    e.stopPropagation();
    setDownloadingId(order.id);
    try {
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
      await updateOrderStatus(order.id, "IN_PROGRESS");
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "다운로드 중 오류가 발생했습니다." });
    } finally {
      setDownloadingId(null);
    }
  };

  const requestLabel = (requestType) => REQUEST_TYPE_LABELS[requestType] || "요청";

  return (
    <div className="order-admin-page">
      {feedback && <div className={`order-feedback ${feedback.type}`}>{feedback.msg}</div>}

      <div className="order-summary">
        <div className="summary-card summary-received">
          <span className="summary-count">{statusCounts.RECEIVED}</span>
          <span className="summary-label">접수완료</span>
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
        {activeFilter === "COMPLETED" && statusCounts.COMPLETED > 0 && (
          <button
            type="button"
            className="bulk-delete-btn"
            onClick={bulkMoveCompletedToTrash}
            disabled={bulkTrashing}
          >
            {bulkTrashing ? "이동 중..." : `완료 ${statusCounts.COMPLETED}건 휴지통으로`}
          </button>
        )}
        {activeFilter === "TRASH" && trashOrders.length > 0 && (
          <button
            type="button"
            className="bulk-delete-btn"
            onClick={bulkPurgeTrash}
            disabled={bulkPurging}
          >
            {bulkPurging ? "삭제 중..." : `휴지통 ${trashOrders.length}건 일괄 영구삭제`}
          </button>
        )}
      </div>
      {activeFilter === "TRASH" && (
        <p className="trash-hint">
          휴지통의 항목은 삭제일로부터 {TRASH_RETENTION_DAYS}일 후 자동으로 영구 삭제됩니다.
        </p>
      )}

      <table className="order-admin-table">
        <thead>
          <tr>
            <th>요청번호</th>
            <th>거래처</th>
            <th>요청유형</th>
            <th>제목</th>
            <th>납기</th>
            <th>{activeFilter === "TRASH" ? "남은 일수" : "상태"}</th>
            <th>{activeFilter === "TRASH" ? "삭제일" : "등록일"}</th>
            <th>처리</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={8} className="order-empty">요청 목록을 불러오는 중입니다.</td>
            </tr>
          ) : filteredOrders.length === 0 ? (
            <tr>
              <td colSpan={8} className="order-empty">
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

              return (
                <tr
                  key={order.id}
                  className={`order-row ${isTrash ? "trash-row" : ""}`}
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
                  <td className="order-num">{order.orderNumber}</td>
                  <td>{order.clientCompanyName || "-"}</td>
                  <td>{requestLabel(order.requestType)}</td>
                  <td>{order.title || requestLabel(order.requestType)}</td>
                  <td>{formatDate(order.dueDate)}</td>
                  <td>
                    {isTrash ? (
                      <span className="status-badge status-trash">
                        {daysLeft === null ? "-" : `${daysLeft}일 남음`}
                      </span>
                    ) : (
                      <span className={`status-badge ${statusMeta.className}`}>{statusMeta.label}</span>
                    )}
                  </td>
                  <td>{formatDate(isTrash ? order.deletedAt : order.createdAt)}</td>
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
                    ) : nextStatus ? (
                      order.status === "RECEIVED" && order.requestType === "ORDER" ? (
                        <button
                          type="button"
                          className="next-status-btn action-worksheet"
                          onClick={(e) => downloadWorksheet(e, order)}
                          disabled={downloadingId === order.id}
                        >
                          {downloadingId === order.id ? "준비 중..." : "지시서 작성하기"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`next-status-btn ${order.status === "RECEIVED" ? "action-start" : "action-complete"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            updateOrderStatus(order.id, nextStatus);
                          }}
                          disabled={updating}
                        >
                          {updating ? "변경 중..." : "다음 단계"}
                        </button>
                      )
                    ) : (
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
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {selectedOrder && (
        <div className="order-preview-modal" onClick={() => setSelectedOrderId(null)}>
          <div className="order-preview-content" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="order-modal-close" onClick={() => setSelectedOrderId(null)}>
              ×
            </button>

            <div className="order-preview-left">
              <div className="order-file-stage">
                {selectedOrder.files?.length ? (
                  <div className="order-preview-file-fallback">
                    <p className="fallback-title">첨부 파일</p>
                    <p className="fallback-desc">아래 링크로 파일을 확인할 수 있습니다.</p>
                  </div>
                ) : (
                  <div className="order-preview-file-fallback">
                    <p className="fallback-title">첨부 파일 없음</p>
                    <p className="fallback-desc">등록된 첨부 파일이 없습니다.</p>
                  </div>
                )}
              </div>

              {selectedOrder.files?.length > 0 && (
                <div className="order-file-strip">
                  {selectedOrder.files.map((file, index) => (
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

              <div className="file-chips" style={{ marginBottom: 16 }}>
                <span className="file-chip">{requestLabel(selectedOrder.requestType)}</span>
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
                      {selectedOrder.status === "RECEIVED" && selectedOrder.requestType === "ORDER" && (
                        <button
                          type="button"
                          className="next-status-btn action-worksheet"
                          disabled={downloadingId === selectedOrder.id}
                          onClick={(e) => downloadWorksheet(e, selectedOrder)}
                        >
                          {downloadingId === selectedOrder.id ? "준비 중..." : "지시서 작성하기"}
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
                  {selectedOrder.files?.length ? (
                    selectedOrder.files.map((file, index) => (
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
          </div>
        </div>
      )}
    </div>
  );
}
