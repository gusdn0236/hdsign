import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getOrdersApi } from '../../api/client';
import './ClientStatus.css';

const STATUS_MAP = {
    RECEIVED:    { label: '접수완료', className: 'badge-received',    step: 1 },
    IN_PROGRESS: { label: '작업중',   className: 'badge-in-progress', step: 2 },
    COMPLETED:   { label: '완료',     className: 'badge-completed',   step: 3 },
};
const DELIVERY_LABELS = { CARGO: '화물 발송', QUICK: '퀵 발송', DIRECT: '직접 납품' };

function StatusBadge({ status }) {
    const s = STATUS_MAP[status] || STATUS_MAP.RECEIVED;
    return (
        <span className={`status-badge ${s.className}`}>
            <span className="badge-dot" />{s.label}
        </span>
    );
}

function StepTracker({ status }) {
    const currentStep = STATUS_MAP[status]?.step || 1;
    const steps = ['접수완료', '작업중', '완료'];
    return (
        <div className="step-tracker">
            {steps.map((label, i) => {
                const step = i + 1;
                const done = step < currentStep, active = step === currentStep;
                return (
                    <React.Fragment key={label}>
                        <div className="step-item">
                            <div className={`step-circle ${done ? 'done' : active ? 'active' : ''}`}>
                                {done ? '✓' : step}
                            </div>
                            <span className={`step-label ${active ? 'active' : done ? 'done' : ''}`}>{label}</span>
                        </div>
                        {i < steps.length - 1 && <div className={`step-line ${done ? 'done' : ''}`} />}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

function OrderCard({ order }) {
    const [open, setOpen] = useState(false);

    // 날짜 포맷 (2026-04-22T20:27:14 → 2026-04-22)
    const formatDate = (dateStr) => {
        if (!dateStr) return '-';
        return dateStr.split('T')[0];
    };

    return (
        <div className={`order-card ${open ? 'expanded' : ''}`}>
            <div className="order-card-header" onClick={() => setOpen(!open)}>
                <div className="order-card-main">
                    <div className="order-top-row">
                        <span className="order-id">{order.orderNumber}</span>
                        <StatusBadge status={order.status} />
                    </div>
                    <p className="order-title">{order.title || '작업 요청'}</p>
                    <p className="order-dates">
                        요청일 {formatDate(order.createdAt)} · 납품희망 {order.dueDate}
                    </p>
                </div>
                <span className={`chevron ${open ? 'open' : ''}`}>▾</span>
            </div>

            {open && (
                <div className="order-card-detail">
                    <div className="step-tracker-wrap">
                        <StepTracker status={order.status} />
                    </div>
                    <div className="detail-grid">
                        <div className="detail-item">
                            <span className="detail-label">파워기(SMPS)</span>
                            <span className="detail-value">{order.hasSMPS ? '✅ 포함' : '❌ 미포함'}</span>
                        </div>
                        <div className="detail-item">
                            <span className="detail-label">납품 방법</span>
                            <span className="detail-value">{DELIVERY_LABELS[order.deliveryMethod] || '-'}</span>
                        </div>
                        <div className="detail-item full-width">
                            <span className="detail-label">납품 주소/지점</span>
                            <span className="detail-value">{order.deliveryAddress || '-'}</span>
                        </div>
                        {order.note && (
                            <div className="detail-item full-width">
                                <span className="detail-label">요청사항</span>
                                <span className="detail-value">{order.note}</span>
                            </div>
                        )}
                    </div>

                    {order.files && order.files.length > 0 && (
                        <div className="detail-files">
                            <span className="detail-label">첨부 파일</span>
                            <div className="file-chips">
                                {order.files.map((f, i) => (
                                    <a key={i} className="file-chip"
                                        href={f.fileUrl} target="_blank" rel="noreferrer">
                                        📎 {f.originalName}
                                    </a>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function ClientStatus() {
    const { clientToken, clientLogout } = useAuth();
    const navigate = useNavigate();
    const [orders, setOrders]   = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState('');
    const [filter, setFilter]   = useState('ALL');

    useEffect(() => {
        (async () => {
            try { setOrders(await getOrdersApi(clientToken)); }
            catch (err) {
                if (err?.status === 401 || err?.status === 403) {
                    clientLogout();
                    navigate('/client/login', { replace: true });
                    return;
                }
                setError('작업 내역을 불러오지 못했습니다.');
            }
            finally { setLoading(false); }
        })();
    }, [clientLogout, clientToken, navigate]);

    const filters = [
        { value: 'ALL',         label: '전체' },
        { value: 'RECEIVED',    label: '접수완료' },
        { value: 'IN_PROGRESS', label: '작업중'   },
        { value: 'COMPLETED',   label: '완료'     },
    ];
    const filtered = filter === 'ALL' ? orders : orders.filter(o => o.status === filter);

    if (loading) return <div className="status-page"><div className="status-loading">불러오는 중...</div></div>;

    return (
        <div className="status-page">
            <div className="status-summary">
                {Object.entries(STATUS_MAP).map(([key, val]) => (
                    <div key={key} className="summary-card">
                        <span className="summary-count">{orders.filter(o => o.status === key).length}</span>
                        <span className="summary-label">{val.label}</span>
                    </div>
                ))}
            </div>
            <div className="status-filter">
                {filters.map(f => (
                    <button key={f.value}
                        className={`filter-btn ${filter === f.value ? 'active' : ''}`}
                        onClick={() => setFilter(f.value)}>
                        {f.label}
                        {f.value !== 'ALL' && (
                            <span className="filter-count">
                                {orders.filter(o => o.status === f.value).length}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            {error && <p className="status-error">{error}</p>}
            {filtered.length === 0 ? (
                <div className="status-empty">
                    <span className="status-empty-icon">📋</span>
                    <p>해당하는 작업 내역이 없습니다.</p>
                </div>
            ) : (
                <div className="order-list">
                    {filtered.map(order => <OrderCard key={order.orderNumber} order={order} />)}
                </div>
            )}
        </div>
    );
}
