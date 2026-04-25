import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getOrdersApi } from '../../api/client';
import PhotoLightbox from '../../components/common/PhotoLightbox.jsx';
import './ClientStatus.css';

const STATUS_MAP = {
    RECEIVED: { label: '접수완료', className: 'badge-received', step: 1 },
    IN_PROGRESS: { label: '작업중', className: 'badge-in-progress', step: 2 },
    COMPLETED: { label: '완료', className: 'badge-completed', step: 3 },
};

const DELIVERY_LABELS = {
    CARGO: '화물 발송',
    QUICK: '퀵 발송',
    DIRECT: '직접 배송',
    PICKUP: '직접 수령',
};

const TYPE_LABELS = {
    ORDER: '작업 요청',
    QUOTE: '견적 요청',
};

function formatDate(value) {
    if (!value) return '-';
    return String(value).split('T')[0];
}

function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusBadge({ status }) {
    const meta = STATUS_MAP[status] || STATUS_MAP.RECEIVED;
    return (
        <span className={`status-badge ${meta.className}`}>
            <span className="badge-dot" />
            {meta.label}
        </span>
    );
}

function StepTracker({ status }) {
    const currentStep = STATUS_MAP[status]?.step || 1;
    const steps = ['접수완료', '작업중', '완료'];

    return (
        <div className="step-tracker">
            {steps.map((label, index) => {
                const step = index + 1;
                const done = step < currentStep;
                const active = step === currentStep;
                return (
                    <React.Fragment key={label}>
                        <div className="step-item">
                            <div className={`step-circle ${done ? 'done' : active ? 'active' : ''}`}>
                                {done ? '✓' : step}
                            </div>
                            <span className={`step-label ${active ? 'active' : done ? 'done' : ''}`}>{label}</span>
                        </div>
                        {index < steps.length - 1 && <div className={`step-line ${done ? 'done' : ''}`} />}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

function OrderCard({ order }) {
    const [open, setOpen] = useState(false);
    const [lightboxIndex, setLightboxIndex] = useState(null);
    const isQuote = order.requestType === 'QUOTE';
    const detailTitle = isQuote ? '견적 요청' : '작업 요청';

    const { workFiles, photoFiles } = useMemo(() => {
        const work = [];
        const photos = [];
        (order.files || []).forEach((file) => {
            if (file.isEvidence) photos.push(file);
            else work.push(file);
        });
        photos.sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return tb - ta;
        });
        return { workFiles: work, photoFiles: photos };
    }, [order.files]);

    const lightboxPhotos = useMemo(
        () =>
            photoFiles.map((file) => ({
                src: file.fileUrl,
                alt: file.originalName,
                dept: file.uploadedDepartment || '부서 미상',
                time: formatDateTime(file.createdAt),
            })),
        [photoFiles]
    );

    return (
        <div className={`order-card ${open ? 'expanded' : ''}`}>
            <div className="order-card-header" onClick={() => setOpen((prev) => !prev)}>
                <div className="order-card-main">
                    <div className="order-top-row">
                        <span className="order-id">{order.orderNumber}</span>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span className="file-chip">{TYPE_LABELS[order.requestType] || detailTitle}</span>
                            <StatusBadge status={order.status} />
                        </div>
                    </div>
                    <p className="order-title">{order.title || detailTitle}</p>
                    <p className="order-dates">
                        요청일 {formatDate(order.createdAt)}
                        {!isQuote && order.dueDate ? ` · 납기 ${formatDate(order.dueDate)}` : ''}
                    </p>
                </div>
                <span className={`chevron ${open ? 'open' : ''}`}>⌄</span>
            </div>

            {open && (
                <div className="order-card-detail">
                    <div className="step-tracker-wrap">
                        <StepTracker status={order.status} />
                    </div>

                    <div className="detail-grid">
                        <div className="detail-item">
                            <span className="detail-label">요청 유형</span>
                            <span className="detail-value">{TYPE_LABELS[order.requestType] || '-'}</span>
                        </div>
                        {!isQuote && (
                            <div className="detail-item">
                                <span className="detail-label">SMPS 포함</span>
                                <span className="detail-value">{order.hasSMPS ? '포함' : '미포함'}</span>
                            </div>
                        )}
                        {!isQuote && (
                            <div className="detail-item">
                                <span className="detail-label">배송 방법</span>
                                <span className="detail-value">{DELIVERY_LABELS[order.deliveryMethod] || '-'}</span>
                            </div>
                        )}
                        {!isQuote && (
                            <div className="detail-item full-width">
                                <span className="detail-label">배송 주소/지점</span>
                                <span className="detail-value">{order.deliveryAddress || '-'}</span>
                            </div>
                        )}
                        {!isQuote && (
                            <div className="detail-item full-width">
                                <span className="detail-label">추가 물품</span>
                                <span className="detail-value">{order.additionalItems || '-'}</span>
                            </div>
                        )}
                        {order.note && (
                            <div className="detail-item full-width">
                                <span className="detail-label">{isQuote ? '문의 내용' : '요청사항'}</span>
                                <span className="detail-value">{order.note}</span>
                            </div>
                        )}
                    </div>

                    {workFiles.length > 0 && (
                        <div className="detail-files">
                            <span className="detail-label">첨부 파일</span>
                            <div className="file-chips">
                                {workFiles.map((file, index) => (
                                    <a
                                        key={`${file.originalName}-${index}`}
                                        className="file-chip"
                                        href={file.fileUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {file.originalName}
                                    </a>
                                ))}
                            </div>
                        </div>
                    )}

                    {photoFiles.length > 0 && (
                        <div className="work-photos">
                            <div className="work-photos-head">
                                <span className="detail-label">작업 사진</span>
                                <span className="work-photos-count">{photoFiles.length}장</span>
                            </div>
                            <div className="work-photos-grid">
                                {photoFiles.map((file, index) => (
                                    <button
                                        type="button"
                                        key={file.id || `${file.originalName}-photo-${index}`}
                                        className="work-photo-item"
                                        onClick={() => setLightboxIndex(index)}
                                    >
                                        <img src={file.fileUrl} alt={file.originalName} loading="lazy" />
                                        <div className="work-photo-meta">
                                            <span className="work-photo-dept">
                                                {file.uploadedDepartment || '부서 미상'}
                                            </span>
                                            <span className="work-photo-time">
                                                {formatDateTime(file.createdAt)}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
            <PhotoLightbox
                photos={lightboxPhotos}
                index={lightboxIndex}
                onClose={() => setLightboxIndex(null)}
                onIndexChange={setLightboxIndex}
            />
        </div>
    );
}

export default function ClientStatus() {
    const { clientToken, clientLogout } = useAuth();
    const navigate = useNavigate();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('ALL');

    useEffect(() => {
        (async () => {
            try {
                setOrders(await getOrdersApi(clientToken));
            } catch (err) {
                if (err?.status === 401 || err?.status === 403) {
                    clientLogout();
                    navigate('/client/login', { replace: true });
                    return;
                }
                setError('작업 이력을 불러오지 못했습니다.');
            } finally {
                setLoading(false);
            }
        })();
    }, [clientLogout, clientToken, navigate]);

    const filters = [
        { value: 'ALL', label: '전체' },
        { value: 'RECEIVED', label: '접수완료' },
        { value: 'IN_PROGRESS', label: '작업중' },
        { value: 'COMPLETED', label: '완료' },
    ];

    const filtered = filter === 'ALL' ? orders : orders.filter((order) => order.status === filter);

    if (loading) {
        return <div className="status-page"><div className="status-loading">불러오는 중...</div></div>;
    }

    return (
        <div className="status-page">
            <div className="status-summary">
                {Object.entries(STATUS_MAP).map(([key, meta]) => (
                    <div key={key} className="summary-card">
                        <span className="summary-count">{orders.filter((order) => order.status === key).length}</span>
                        <span className="summary-label">{meta.label}</span>
                    </div>
                ))}
            </div>

            <div className="status-filter">
                {filters.map((item) => (
                    <button
                        key={item.value}
                        className={`filter-btn ${filter === item.value ? 'active' : ''}`}
                        onClick={() => setFilter(item.value)}
                    >
                        {item.label}
                        {item.value !== 'ALL' && (
                            <span className="filter-count">
                                {orders.filter((order) => order.status === item.value).length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {error && <p className="status-error">{error}</p>}

            {filtered.length === 0 ? (
                <div className="status-empty">
                    <span className="status-empty-icon">문서</span>
                    <p>표시할 요청 이력이 없습니다.</p>
                </div>
            ) : (
                <div className="order-list">
                    {filtered.map((order) => (
                        <OrderCard key={order.orderNumber} order={order} />
                    ))}
                </div>
            )}
        </div>
    );
}
