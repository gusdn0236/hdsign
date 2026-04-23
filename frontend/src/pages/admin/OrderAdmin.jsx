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
const STATUS_ACTION_LABEL = {
  RECEIVED: "작업 시작",
  IN_PROGRESS: "작업 완료",
  COMPLETED: "완료 작업 삭제",
};

const DELIVERY_LABELS = {
  CARGO: "화물 발송",
  QUICK: "퀵 발송",
  DIRECT: "직접 배송",
  PICKUP: "직접 픽업",
};

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"];

function formatDate(value) {
  if (!value) return "-";
  return String(value).split("T")[0];
}

function getFileExtension(name = "") {
  const parts = String(name).split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function getPreviewType(file) {
  if (file?.previewUrl) return "image";

  const contentType = String(file?.contentType || "").toLowerCase();
  const extension = getFileExtension(file?.originalName);

  if (contentType.startsWith("image/") || IMAGE_EXTENSIONS.includes(extension)) {
    return "image";
  }
  if (contentType.includes("pdf") || extension === "pdf") {
    return "pdf";
  }
  if (
    extension === "ai" ||
    contentType.includes("illustrator") ||
    contentType.includes("postscript")
  ) {
    return "ai";
  }
  return "other";
}

function getInitialFileIndex(files = []) {
  const index = files.findIndex((file) => getPreviewType(file) !== "other");
  return index >= 0 ? index : 0;
}

function getNextStatus(status) {
  const currentIndex = STATUS_ORDER.indexOf(status);
  if (currentIndex < 0 || currentIndex === STATUS_ORDER.length - 1) {
    return null;
  }
  return STATUS_ORDER[currentIndex + 1];
}

function OrderFilePreview({ file }) {
  const previewType = getPreviewType(file);
  const imageSource = file?.previewUrl || file?.fileUrl;
  const [aiPreviewUrl, setAiPreviewUrl] = useState("");
  const [aiPreviewError, setAiPreviewError] = useState(false);

  useEffect(() => {
    if (previewType !== "ai" || !file?.fileUrl) {
      setAiPreviewUrl("");
      setAiPreviewError(false);
      return;
    }

    let revokedUrl = "";
    let active = true;

    const loadAiPreview = async () => {
      try {
        setAiPreviewError(false);
        const res = await fetch(file.fileUrl);
        if (!res.ok) throw new Error("AI file fetch failed");
        const data = await res.arrayBuffer();
        const blob = new Blob([data], { type: "application/pdf" });
        revokedUrl = URL.createObjectURL(blob);
        if (active) setAiPreviewUrl(revokedUrl);
      } catch {
        if (active) {
          setAiPreviewUrl("");
          setAiPreviewError(true);
        }
      }
    };

    loadAiPreview();

    return () => {
      active = false;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [previewType, file?.fileUrl]);

  if (previewType === "image") {
    return <img src={imageSource} alt={file.originalName} className="order-preview-image" />;
  }

  if (previewType === "pdf") {
    return (
      <iframe
        src={file.fileUrl}
        title={file.originalName}
        className="order-preview-pdf"
      />
    );
  }

  if (previewType === "ai") {
    if (aiPreviewUrl) {
      return (
        <iframe
          src={aiPreviewUrl}
          title={file.originalName}
          className="order-preview-pdf"
        />
      );
    }

    if (!aiPreviewError) {
      return (
        <div className="order-preview-file-fallback">
          <p className="fallback-title">{file.originalName}</p>
          <p className="fallback-desc">AI 미리보기를 불러오는 중입니다.</p>
        </div>
      );
    }

    return (
      <div className="order-preview-file-fallback">
        <p className="fallback-title">{file.originalName}</p>
        <p className="fallback-desc">AI 미리보기에 실패했습니다. 파일을 직접 열어주세요.</p>
        <a href={file.fileUrl} target="_blank" rel="noreferrer" className="fallback-open-link">
          새 창에서 파일 열기
        </a>
      </div>
    );
  }

  return (
    <div className="order-preview-file-fallback">
      <p className="fallback-title">{file.originalName}</p>
      <p className="fallback-desc">이 파일 형식은 브라우저 미리보기를 지원하지 않습니다.</p>
      <a href={file.fileUrl} target="_blank" rel="noreferrer" className="fallback-open-link">
        새 창에서 파일 열기
      </a>
    </div>
  );
}

export default function OrderAdmin() {
  const { token } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [activeFilter, setActiveFilter] = useState("ALL");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
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

  const selectedFiles = selectedOrder?.files || [];
  const selectedFile = selectedFiles[selectedFileIndex] || null;

  useEffect(() => {
    if (!selectedOrder) {
      setPendingStatus("");
      return;
    }
    setPendingStatus(selectedOrder.status);
  }, [selectedOrder]);

  useEffect(() => {
    if (!selectedOrder) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setSelectedOrderId(null);
      }
      if (e.key === "ArrowLeft" && selectedFiles.length > 1) {
        setSelectedFileIndex((prev) => Math.max(0, prev - 1));
      }
      if (e.key === "ArrowRight" && selectedFiles.length > 1) {
        setSelectedFileIndex((prev) => Math.min(selectedFiles.length - 1, prev + 1));
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedOrder, selectedFiles.length]);

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

  const openModal = (order) => {
    const files = order.files || [];
    setSelectedOrderId(order.id);
    setSelectedFileIndex(getInitialFileIndex(files));
  };

  const closeModal = () => {
    setSelectedOrderId(null);
    setSelectedFileIndex(0);
  };

  const moveFile = (direction) => {
    setSelectedFileIndex((prev) =>
      Math.max(0, Math.min(selectedFiles.length - 1, prev + direction))
    );
  };

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
      setFeedback({ type: "error", msg: "완료된 작업만 삭제할 수 있습니다." });
      return;
    }
    if (!window.confirm("완료 작업을 삭제하시겠습니까? 파일도 함께 삭제됩니다.")) return;

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
      if (selectedOrderId === order.id) closeModal();
      setFeedback({ type: "success", msg: "완료 작업이 삭제되었습니다." });
    } catch (err) {
      setFeedback({ type: "error", msg: err.message || "삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingOrderId(null);
    }
  };

  const moveToCompletedHistory = () => {
    setActiveFilter("COMPLETED");
    closeModal();
    setFeedback({
      type: "info",
      msg: "이전 작업 내역으로 이동했습니다. 완료 탭에서 삭제하기를 눌러 최종 삭제하세요.",
    });
  };

  const filterTabs = [
    { key: "ALL", label: "전체", count: orders.length },
    { key: "RECEIVED", label: STATUS_META.RECEIVED.label, count: statusCounts.RECEIVED },
    { key: "IN_PROGRESS", label: STATUS_META.IN_PROGRESS.label, count: statusCounts.IN_PROGRESS },
    { key: "COMPLETED", label: STATUS_META.COMPLETED.label, count: statusCounts.COMPLETED },
  ];

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
            <th>주문번호</th>
            <th>거래처</th>
            <th>작업명</th>
            <th>납기일</th>
            <th>상태</th>
            <th>등록일</th>
            <th>진행상황변경</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={7} className="order-empty">주문 목록을 불러오는 중입니다.</td>
            </tr>
          ) : filteredOrders.length === 0 ? (
            <tr>
              <td colSpan={7} className="order-empty">표시할 주문이 없습니다.</td>
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
                  onClick={() => openModal(order)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openModal(order);
                    }
                  }}
                >
                  <td className="order-num">{order.orderNumber}</td>
                  <td>{order.clientCompanyName || "-"}</td>
                  <td>{order.title || "작업 요청"}</td>
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
                        {updating ? "변경중..." : STATUS_ACTION_LABEL[order.status]}
                      </button>
                    ) : (
                      activeFilter === "COMPLETED" ? (
                        <button
                          type="button"
                          className="next-status-btn action-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCompletedOrder(order);
                          }}
                          disabled={deleting}
                        >
                          {deleting ? "삭제중..." : "삭제하기"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="next-status-btn action-history"
                          onClick={(e) => {
                            e.stopPropagation();
                            moveToCompletedHistory();
                          }}
                        >
                          {STATUS_ACTION_LABEL.COMPLETED}
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {selectedOrder && (
        <div className="order-preview-modal" onClick={closeModal}>
          <div className="order-preview-content" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="order-modal-close" onClick={closeModal}>
              ×
            </button>

            <div className="order-preview-left">
              <div className="order-file-stage">
                {selectedFile ? (
                  <OrderFilePreview file={selectedFile} />
                ) : (
                  <div className="order-preview-file-fallback">
                    <p className="fallback-title">첨부 파일 없음</p>
                    <p className="fallback-desc">업로드된 파일이 없습니다.</p>
                  </div>
                )}

                {selectedFiles.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="order-file-nav prev"
                      onClick={() => moveFile(-1)}
                      disabled={selectedFileIndex === 0}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="order-file-nav next"
                      onClick={() => moveFile(1)}
                      disabled={selectedFileIndex === selectedFiles.length - 1}
                    >
                      ›
                    </button>
                  </>
                )}
              </div>

              {selectedFiles.length > 0 && (
                <div className="order-file-strip">
                  {selectedFiles.map((file, index) => (
                    <button
                      type="button"
                      key={file.id || `${file.originalName}-${index}`}
                      className={`order-file-chip ${selectedFileIndex === index ? "active" : ""}`}
                      onClick={() => setSelectedFileIndex(index)}
                    >
                      {file.originalName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <aside className="order-preview-info">
              <p className="modal-order-no">{selectedOrder.orderNumber}</p>
              <h3 className="modal-order-title">{selectedOrder.title || "작업 요청"}</h3>

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
                  {pendingStatus === selectedOrder.status && (
                    <span className="status-help-text">변경할 상태를 선택하면 적용됩니다.</span>
                  )}
                  <button
                    type="button"
                    className={`next-status-btn ${
                      pendingStatus === selectedOrder.status
                        ? "is-idle"
                        : pendingStatus === "IN_PROGRESS"
                          ? "action-start"
                          : pendingStatus === "COMPLETED"
                            ? "action-complete"
                            : ""
                    }`}
                    disabled={statusUpdatingId === selectedOrder.id || deletingOrderId === selectedOrder.id}
                    onClick={() => {
                      if (!pendingStatus || pendingStatus === selectedOrder.status) {
                        setFeedback({ type: "info", msg: "현재 상태와 동일합니다. 다른 상태를 선택해 주세요." });
                        return;
                      }
                      updateOrderStatus(selectedOrder.id, pendingStatus);
                    }}
                  >
                    {statusUpdatingId === selectedOrder.id ? "변경중..." : "상태 변경하기"}
                  </button>
                  {selectedOrder.status === "COMPLETED" && (
                    activeFilter === "COMPLETED" ? (
                      <button
                        type="button"
                        className="next-status-btn action-delete"
                        disabled={deletingOrderId === selectedOrder.id}
                        onClick={() => deleteCompletedOrder(selectedOrder)}
                      >
                        {deletingOrderId === selectedOrder.id ? "삭제중..." : "삭제하기"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="next-status-btn action-history"
                        onClick={moveToCompletedHistory}
                      >
                        완료 작업 삭제
                      </button>
                    )
                  )}
                </div>
              </div>

              <div className="modal-detail-grid">
                <div className="detail-section">
                  <span className="detail-label">거래처</span>
                  <span className="detail-value">{selectedOrder.clientCompanyName || "-"}</span>
                </div>
                <div className="detail-section">
                  <span className="detail-label">추가 물품</span>
                  <span className="detail-value">{selectedOrder.additionalItems || "없음"}</span>
                </div>
                <div className="detail-section">
                  <span className="detail-label">납기일</span>
                  <span className="detail-value">
                    {formatDate(selectedOrder.dueDate)}
                    {selectedOrder.dueTime ? ` (${selectedOrder.dueTime})` : ''}
                  </span>
                </div>
                <div className="detail-section">
                  <span className="detail-label">납품방법</span>
                  <span className="detail-value">{DELIVERY_LABELS[selectedOrder.deliveryMethod] || "-"}</span>
                </div>
                <div className="detail-section full">
                  <span className="detail-label">납품지/주소</span>
                  <span className="detail-value">{selectedOrder.deliveryAddress || "-"}</span>
                </div>
                <div className="detail-section full">
                  <span className="detail-label">요청사항</span>
                  <span className="detail-value">{selectedOrder.note || "-"}</span>
                </div>
              </div>

              <div className="modal-file-links">
                <span className="detail-label">첨부파일</span>
                <div className="file-chips">
                  {selectedFiles.length === 0 ? (
                    <span className="detail-value">첨부 파일 없음</span>
                  ) : (
                    selectedFiles.map((file, index) => (
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
