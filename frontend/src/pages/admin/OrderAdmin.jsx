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
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [activeFilter, setActiveFilter] = useState("ALL");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [pendingStatus, setPendingStatus] = useState("");
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const [deletingOrderId, setDeletingOrderId] = useState(null);

  const loadOrders = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error("주문 목록을 불러오지 못했습니다.");
      }
      const data = await res.json();
      setOrders(Array.isArray(data) ? data : []);
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
    () => orders.find((order) => order.id === selectedOrderId) || null,
    [orders, selectedOrderId]
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
    if (activeFilter === "ALL") return orders;
    return orders.filter((order) => order.status === activeFilter);
  }, [activeFilter, orders]);

  const filterTabs = [
    { key: "ALL", label: "전체", count: orders.length },
    { key: "RECEIVED", label: STATUS_META.RECEIVED.label, count: statusCounts.RECEIVED },
    { key: "IN_PROGRESS", label: STATUS_META.IN_PROGRESS.label, count: statusCounts.IN_PROGRESS },
    { key: "COMPLETED", label: STATUS_META.COMPLETED.label, count: statusCounts.COMPLETED },
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

  const deleteCompletedOrder = async (order) => {
    if (!order || order.status !== "COMPLETED") {
      setFeedback({ type: "error", msg: "완료된 요청만 삭제할 수 있습니다." });
      return;
    }
    if (!window.confirm("완료된 요청을 삭제하시겠습니까? 첨부 파일도 함께 삭제됩니다.")) {
      return;
    }

    setDeletingOrderId(order.id);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/orders/${order.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.message || "삭제에 실패했습니다.");
      }

      setOrders((prev) => prev.filter((item) => item.id !== order.id));
      if (selectedOrderId === order.id) setSelectedOrderId(null);
      setFeedback({ type: "success", msg: "완료 요청을 삭제했습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingOrderId(null);
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
            className={`filter-tab ${activeFilter === tab.key ? "active" : ""}`}
            onClick={() => setActiveFilter(tab.key)}
          >
            {tab.label}
            <span className="tab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      <table className="order-admin-table">
        <thead>
          <tr>
            <th>요청번호</th>
            <th>거래처</th>
            <th>요청유형</th>
            <th>제목</th>
            <th>납기</th>
            <th>상태</th>
            <th>등록일</th>
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
              <td colSpan={8} className="order-empty">표시할 요청이 없습니다.</td>
            </tr>
          ) : (
            filteredOrders.map((order) => {
              const statusMeta = STATUS_META[order.status] || STATUS_META.RECEIVED;
              const nextStatus = getNextStatus(order.status);
              const updating = statusUpdatingId === order.id;
              const deleting = deletingOrderId === order.id;

              return (
                <tr
                  key={order.id}
                  className="order-row"
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
                    <span className={`status-badge ${statusMeta.className}`}>{statusMeta.label}</span>
                  </td>
                  <td>{formatDate(order.createdAt)}</td>
                  <td>
                    {nextStatus ? (
                      <button
                        type="button"
                        className={`next-status-btn ${order.status === "RECEIVED" ? "action-start" : "action-complete"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateOrderStatus(order.id, nextStatus);
                        }}
                        disabled={updating || deleting}
                      >
                        {updating ? "변경 중..." : "다음 단계"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="next-status-btn action-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCompletedOrder(order);
                        }}
                        disabled={deleting}
                      >
                        {deleting ? "삭제 중..." : "삭제"}
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
                <span className={`status-badge ${(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).className}`}>
                  {(STATUS_META[selectedOrder.status] || STATUS_META.RECEIVED).label}
                </span>
                <div className="modal-status-actions">
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
                      deletingOrderId === selectedOrder.id ||
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
                      className="next-status-btn action-delete"
                      disabled={deletingOrderId === selectedOrder.id}
                      onClick={() => deleteCompletedOrder(selectedOrder)}
                    >
                      {deletingOrderId === selectedOrder.id ? "삭제 중..." : "삭제"}
                    </button>
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
