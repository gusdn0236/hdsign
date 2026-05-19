import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import './EvidenceAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const PAGE_SIZE = 60;
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

function formatTime(s) {
    if (!s) return '';
    try {
        const d = new Date(s);
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mi}`;
    } catch {
        return '';
    }
}

function formatDateHeader(dateKey) {
    if (!dateKey || dateKey === 'unknown') return '날짜 미상';
    const [yyyy, mm, dd] = dateKey.split('-');
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    const wd = WEEKDAYS_KO[d.getDay()];
    return `${yyyy}.${mm}.${dd} (${wd})`;
}

function dateKeyOf(item) {
    if (!item?.createdAt) return 'unknown';
    return String(item.createdAt).slice(0, 10);
}

export default function EvidenceAdmin() {
    const { token } = useAuth();
    const authHeader = useMemo(
        () => ({ Authorization: `Bearer ${token}` }),
        [token],
    );

    // 검색 인풋 (타이핑 중 값) + 실제 적용된 쿼리(엔터 후) 분리
    const [searchInput, setSearchInput] = useState('');
    const [appliedQuery, setAppliedQuery] = useState('');

    const [items, setItems] = useState([]);
    const [page, setPage] = useState(0);
    const [hasNext, setHasNext] = useState(false);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const [lightboxIndex, setLightboxIndex] = useState(-1);

    const loadPage = useCallback(
        async (targetPage, append) => {
            setLoading(true);
            setError('');
            try {
                const params = new URLSearchParams();
                params.set('page', String(targetPage));
                params.set('size', String(PAGE_SIZE));
                if (appliedQuery) params.set('q', appliedQuery);
                const res = await fetch(`${BASE_URL}/api/admin/evidence?${params}`, { headers: authHeader });
                if (!res.ok) throw new Error('사진 목록을 불러오지 못했습니다.');
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
        [authHeader, appliedQuery],
    );

    // 적용된 쿼리 바뀌면 첫 페이지부터 다시 로드
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

    // 라이트박스 ESC/화살표
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

    const handleSearchSubmit = (e) => {
        e.preventDefault();
        setAppliedQuery(searchInput.trim());
    };

    const handleClearSearch = () => {
        setSearchInput('');
        setAppliedQuery('');
    };

    // 날짜별 그룹핑 — items 가 createdAt DESC 정렬되어 들어오므로 순서 유지된다.
    // groups: [{ dateKey, items: [...] }, ...]
    const groups = useMemo(() => {
        const result = [];
        let current = null;
        for (const it of items) {
            const k = dateKeyOf(it);
            if (!current || current.dateKey !== k) {
                current = { dateKey: k, items: [] };
                result.push(current);
            }
            current.items.push(it);
        }
        return result;
    }, [items]);

    const active = lightboxIndex >= 0 && lightboxIndex < items.length ? items[lightboxIndex] : null;

    return (
        <div className="evidence-admin-page">
            <div className="evidence-admin-header">
                <h2 className="evidence-admin-title">현장작업완료사진</h2>
                <div className="evidence-admin-count">
                    총 <strong>{total.toLocaleString()}</strong>장
                </div>
            </div>

            <form className="evidence-admin-toolbar" onSubmit={handleSearchSubmit}>
                <div className="evidence-search-wrap">
                    <svg className="evidence-search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                        <path d="M9 2a7 7 0 015.29 11.54l3.58 3.58a1 1 0 01-1.41 1.41l-3.58-3.58A7 7 0 119 2zm0 2a5 5 0 100 10A5 5 0 009 4z" fill="currentColor"/>
                    </svg>
                    <input
                        type="text"
                        className="evidence-search-input"
                        placeholder="거래처 검색 (엔터)"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                    />
                    {(searchInput || appliedQuery) && (
                        <button
                            type="button"
                            className="evidence-search-clear"
                            onClick={handleClearSearch}
                            aria-label="검색어 지우기"
                        >×</button>
                    )}
                </div>
                {appliedQuery && (
                    <div className="evidence-search-chip">
                        <span>‘{appliedQuery}’ 검색 결과</span>
                    </div>
                )}
            </form>

            {error && <div className="evidence-admin-error">{error}</div>}

            {!loading && items.length === 0 && !error && (
                <div className="evidence-admin-empty">
                    {appliedQuery
                        ? `‘${appliedQuery}’에 해당하는 사진이 없습니다.`
                        : '아직 업로드된 작업완료 사진이 없습니다.'}
                </div>
            )}

            <div className="evidence-groups">
                {groups.map((group) => (
                    <section key={group.dateKey} className="evidence-group">
                        <header className="evidence-group-header">
                            <h3>{formatDateHeader(group.dateKey)}</h3>
                            <span className="evidence-group-count">{group.items.length}장</span>
                        </header>
                        <div className="evidence-grid">
                            {group.items.map((it) => {
                                const idx = items.indexOf(it);
                                return (
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
                                            <span className="evidence-card-time-badge">{formatTime(it.createdAt)}</span>
                                        </div>
                                        <div className="evidence-card-meta">
                                            <div className="evidence-card-company">{it.companyName || '거래처미상'}</div>
                                            <div className="evidence-card-sub">
                                                <span>{it.orderNumber || '-'}</span>
                                                {it.uploadedDepartment && (
                                                    <span className="evidence-card-dept">· {it.uploadedDepartment}</span>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
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
                            <div>{formatDateHeader(dateKeyOf(active))} {formatTime(active.createdAt)}</div>
                            <div className="evidence-lightbox-filename">{active.originalName}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
