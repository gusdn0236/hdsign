import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import './EvidenceAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const PAGE_SIZE = 60;

function formatDateTime(s) {
    if (!s) return '';
    try {
        const d = new Date(s);
        const yy = String(d.getFullYear()).slice(2);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${yy}-${mm}-${dd} ${hh}:${mi}`;
    } catch {
        return s;
    }
}

export default function EvidenceAdmin() {
    const { token } = useAuth();
    const authHeader = useMemo(
        () => ({ Authorization: `Bearer ${token}` }),
        [token],
    );

    const [clients, setClients] = useState([]);
    const [filterClientId, setFilterClientId] = useState('');
    const [filterFrom, setFilterFrom] = useState('');
    const [filterTo, setFilterTo] = useState('');

    const [items, setItems] = useState([]);
    const [page, setPage] = useState(0);
    const [hasNext, setHasNext] = useState(false);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const [lightboxIndex, setLightboxIndex] = useState(-1);

    useEffect(() => {
        fetch(`${BASE_URL}/api/admin/clients`, { headers: authHeader })
            .then((r) => (r.ok ? r.json() : []))
            .then((data) => {
                const list = Array.isArray(data) ? data : [];
                list.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || '', 'ko'));
                setClients(list);
            })
            .catch(() => setClients([]));
    }, [authHeader]);

    const loadPage = useCallback(
        async (targetPage, append) => {
            setLoading(true);
            setError('');
            try {
                const params = new URLSearchParams();
                params.set('page', String(targetPage));
                params.set('size', String(PAGE_SIZE));
                if (filterClientId) params.set('clientId', filterClientId);
                if (filterFrom) params.set('from', filterFrom);
                if (filterTo) params.set('to', filterTo);
                const res = await fetch(`${BASE_URL}/api/admin/evidence?${params}`, { headers: authHeader });
                if (!res.ok) throw new Error('증거사진 목록을 불러오지 못했습니다.');
                const data = await res.json();
                const content = Array.isArray(data.content) ? data.content : [];
                setItems((prev) => (append ? [...prev, ...content] : content));
                setPage(data.page ?? targetPage);
                setHasNext(Boolean(data.hasNext));
                setTotal(data.totalElements ?? 0);
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        },
        [authHeader, filterClientId, filterFrom, filterTo],
    );

    // 필터 변경 시 첫 페이지부터 다시
    useEffect(() => {
        loadPage(0, false);
    }, [loadPage]);

    // 무한스크롤 — IntersectionObserver
    const sentinelRef = useRef(null);
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        if (!hasNext) return;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && !loading) {
                    loadPage(page + 1, true);
                }
            },
            { rootMargin: '400px' },
        );
        io.observe(el);
        return () => io.disconnect();
    }, [hasNext, loading, page, loadPage]);

    // 라이트박스 ESC 닫기 + 좌우 화살표 네비
    useEffect(() => {
        if (lightboxIndex < 0) return;
        const onKey = (e) => {
            if (e.key === 'Escape') setLightboxIndex(-1);
            else if (e.key === 'ArrowLeft') setLightboxIndex((i) => Math.max(0, i - 1));
            else if (e.key === 'ArrowRight') setLightboxIndex((i) => Math.min(items.length - 1, i + 1));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [lightboxIndex, items.length]);

    const handleReset = () => {
        setFilterClientId('');
        setFilterFrom('');
        setFilterTo('');
    };

    const active = lightboxIndex >= 0 && lightboxIndex < items.length ? items[lightboxIndex] : null;

    return (
        <div className="evidence-admin-page">
            <div className="evidence-admin-header">
                <h2 className="evidence-admin-title">현장증거사진</h2>
                <div className="evidence-admin-count">
                    총 <strong>{total.toLocaleString()}</strong>장
                </div>
            </div>

            <div className="evidence-admin-toolbar">
                <label className="evidence-admin-field">
                    <span>거래처</span>
                    <select
                        value={filterClientId}
                        onChange={(e) => setFilterClientId(e.target.value)}
                    >
                        <option value="">전체</option>
                        {clients.map((c) => (
                            <option key={c.id} value={c.id}>{c.companyName}</option>
                        ))}
                    </select>
                </label>
                <label className="evidence-admin-field">
                    <span>시작일</span>
                    <input
                        type="date"
                        value={filterFrom}
                        onChange={(e) => setFilterFrom(e.target.value)}
                    />
                </label>
                <label className="evidence-admin-field">
                    <span>종료일</span>
                    <input
                        type="date"
                        value={filterTo}
                        onChange={(e) => setFilterTo(e.target.value)}
                    />
                </label>
                <button
                    type="button"
                    className="evidence-admin-reset"
                    onClick={handleReset}
                    disabled={!filterClientId && !filterFrom && !filterTo}
                >
                    초기화
                </button>
            </div>

            {error && <div className="evidence-admin-error">{error}</div>}

            {!loading && items.length === 0 && !error && (
                <div className="evidence-admin-empty">
                    조건에 맞는 증거사진이 없습니다.
                </div>
            )}

            <div className="evidence-grid">
                {items.map((it, idx) => (
                    <button
                        key={it.id}
                        type="button"
                        className="evidence-card"
                        onClick={() => setLightboxIndex(idx)}
                    >
                        <div className="evidence-card-img-wrap">
                            <img
                                src={it.fileUrl}
                                alt={it.originalName || ''}
                                loading="lazy"
                                decoding="async"
                            />
                        </div>
                        <div className="evidence-card-meta">
                            <div className="evidence-card-company">{it.companyName || '거래처미상'}</div>
                            <div className="evidence-card-sub">
                                <span>{it.orderNumber || '-'}</span>
                                {it.uploadedDepartment && (
                                    <span className="evidence-card-dept">· {it.uploadedDepartment}</span>
                                )}
                            </div>
                            <div className="evidence-card-time">{formatDateTime(it.createdAt)}</div>
                        </div>
                    </button>
                ))}
            </div>

            <div ref={sentinelRef} className="evidence-sentinel">
                {loading && <span className="evidence-loading">불러오는 중…</span>}
                {!loading && !hasNext && items.length > 0 && <span className="evidence-end">— 끝 —</span>}
            </div>

            {active && (
                <div className="evidence-lightbox" onClick={() => setLightboxIndex(-1)}>
                    <button
                        type="button"
                        className="evidence-lightbox-close"
                        onClick={(e) => { e.stopPropagation(); setLightboxIndex(-1); }}
                        aria-label="닫기"
                    >×</button>
                    {lightboxIndex > 0 && (
                        <button
                            type="button"
                            className="evidence-lightbox-prev"
                            onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
                            aria-label="이전"
                        >‹</button>
                    )}
                    {lightboxIndex < items.length - 1 && (
                        <button
                            type="button"
                            className="evidence-lightbox-next"
                            onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
                            aria-label="다음"
                        >›</button>
                    )}
                    <div className="evidence-lightbox-body" onClick={(e) => e.stopPropagation()}>
                        <img src={active.fileUrl} alt={active.originalName || ''} />
                        <div className="evidence-lightbox-meta">
                            <div><strong>{active.companyName || '거래처미상'}</strong></div>
                            <div>{active.orderNumber} · {active.orderTitle || '제목없음'}</div>
                            {active.uploadedDepartment && <div>부서: {active.uploadedDepartment}</div>}
                            <div>{formatDateTime(active.createdAt)}</div>
                            <div className="evidence-lightbox-filename">{active.originalName}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
