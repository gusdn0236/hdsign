import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import './EvidenceAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const PAGE_SIZE = 60;
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DEFAULT_TAGS = ['완조립', 'LED', 'CNC', '5층아크릴'];

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

    const [searchInput, setSearchInput] = useState('');
    const [appliedQuery, setAppliedQuery] = useState('');
    const [activeTag, setActiveTag] = useState('');
    const [availableTags, setAvailableTags] = useState(DEFAULT_TAGS);

    const [items, setItems] = useState([]);
    const [page, setPage] = useState(0);
    const [hasNext, setHasNext] = useState(false);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const [lightboxIndex, setLightboxIndex] = useState(-1);

    // 선택 모드 + 선택된 ID 셋
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState(() => new Set());
    const [deleting, setDeleting] = useState(false);

    const loadPage = useCallback(
        async (targetPage, append) => {
            setLoading(true);
            setError('');
            try {
                const params = new URLSearchParams();
                params.set('page', String(targetPage));
                params.set('size', String(PAGE_SIZE));
                if (appliedQuery) params.set('q', appliedQuery);
                if (activeTag) params.set('tag', activeTag);
                const res = await fetch(`${BASE_URL}/api/admin/evidence?${params}`, { headers: authHeader });
                if (!res.ok) throw new Error('사진 목록을 불러오지 못했습니다.');
                const data = await res.json();
                const content = Array.isArray(data.content) ? data.content : [];
                setItems((prev) => (append ? [...prev, ...content] : content));
                setPage(data.page ?? targetPage);
                setHasNext(Boolean(data.hasNext));
                setTotal(data.totalElements ?? 0);
                if (Array.isArray(data.availableTags) && data.availableTags.length > 0) {
                    setAvailableTags(data.availableTags);
                }
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        },
        [authHeader, appliedQuery, activeTag],
    );

    // 필터(검색/태그) 바뀌면 첫 페이지부터 다시 + 선택 초기화
    useEffect(() => {
        loadPage(0, false);
        setSelected(new Set());
    }, [loadPage]);

    // 무한스크롤
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

    // 라이트박스 키보드
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
    const handlePickTag = (tag) => {
        setActiveTag((prev) => (prev === tag ? '' : tag));
    };

    const toggleSelectMode = () => {
        setSelectMode((prev) => {
            if (prev) setSelected(new Set()); // 끄면서 선택 초기화
            return !prev;
        });
    };
    const toggleSelected = (id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const selectAllVisible = () => {
        setSelected(new Set(items.map((it) => it.id)));
    };
    const clearSelection = () => setSelected(new Set());

    const handleBulkDelete = async () => {
        if (selected.size === 0) return;
        const count = selected.size;
        const ok = window.confirm(`선택한 ${count}장을 영구 삭제합니다.\n복구할 수 없습니다. 진행하시겠습니까?`);
        if (!ok) return;
        setDeleting(true);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/evidence`, {
                method: 'DELETE',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(selected) }),
            });
            if (!res.ok) throw new Error('삭제 실패');
            const data = await res.json().catch(() => ({}));
            const deletedIds = new Set(Array.from(selected));
            setItems((prev) => prev.filter((it) => !deletedIds.has(it.id)));
            setTotal((prev) => Math.max(0, prev - (data.deletedDb ?? count)));
            setSelected(new Set());
            setSelectMode(false);
        } catch (e) {
            window.alert(e.message);
        } finally {
            setDeleting(false);
        }
    };

    // 날짜 그룹핑
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
                <div className="evidence-admin-header-right">
                    <div className="evidence-admin-count">
                        총 <strong>{total.toLocaleString()}</strong>장
                    </div>
                    <button
                        type="button"
                        className={`evidence-select-toggle${selectMode ? ' active' : ''}`}
                        onClick={toggleSelectMode}
                    >
                        {selectMode ? '선택 취소' : '선택'}
                    </button>
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
            </form>

            <div className="evidence-tag-row">
                <button
                    type="button"
                    className={`evidence-tag-chip${!activeTag ? ' active' : ''}`}
                    onClick={() => setActiveTag('')}
                >전체</button>
                {availableTags.map((t) => (
                    <button
                        key={t}
                        type="button"
                        className={`evidence-tag-chip tag-${tagClassName(t)}${activeTag === t ? ' active' : ''}`}
                        onClick={() => handlePickTag(t)}
                    >{t}</button>
                ))}
            </div>

            {selectMode && (
                <div className="evidence-select-bar">
                    <span>{selected.size}장 선택됨</span>
                    <div className="evidence-select-actions">
                        <button type="button" onClick={selectAllVisible} disabled={items.length === 0}>
                            현재 보이는 {items.length}장 모두 선택
                        </button>
                        <button type="button" onClick={clearSelection} disabled={selected.size === 0}>
                            선택 해제
                        </button>
                        <button
                            type="button"
                            className="evidence-delete-btn"
                            onClick={handleBulkDelete}
                            disabled={selected.size === 0 || deleting}
                        >
                            {deleting ? '삭제 중…' : `선택 ${selected.size}장 삭제`}
                        </button>
                    </div>
                </div>
            )}

            {error && <div className="evidence-admin-error">{error}</div>}

            {!loading && items.length === 0 && !error && (
                <div className="evidence-admin-empty">
                    {appliedQuery || activeTag
                        ? '해당 조건에 맞는 사진이 없습니다.'
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
                                const isChecked = selected.has(it.id);
                                const handleClick = () => {
                                    if (selectMode) toggleSelected(it.id);
                                    else setLightboxIndex(idx);
                                };
                                return (
                                    <button
                                        key={it.id}
                                        type="button"
                                        className={`evidence-card${isChecked ? ' selected' : ''}`}
                                        onClick={handleClick}
                                    >
                                        {selectMode && (
                                            <span className={`evidence-checkbox${isChecked ? ' checked' : ''}`} aria-hidden="true">
                                                {isChecked && '✓'}
                                            </span>
                                        )}
                                        <div className="evidence-card-img-wrap">
                                            <img
                                                src={it.fileUrl}
                                                alt={it.originalName || ''}
                                                loading="lazy"
                                                decoding="async"
                                            />
                                            <span className="evidence-card-time-badge">{formatTime(it.createdAt)}</span>
                                            {it.tag && (
                                                <span className={`evidence-card-tag tag-${tagClassName(it.tag)}`}>{it.tag}</span>
                                            )}
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
                            {active.uploadedDepartment && <div>작업자: {active.uploadedDepartment}</div>}
                            {active.tag && <div>태그: <span className={`evidence-lightbox-tag tag-${tagClassName(active.tag)}`}>{active.tag}</span></div>}
                            <div>{formatDateHeader(dateKeyOf(active))} {formatTime(active.createdAt)}</div>
                            <div className="evidence-lightbox-filename">{active.originalName}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// 태그 이름에서 CSS 클래스 안전한 토큰 생성 — "5층아크릴" 등 한글/숫자 포함.
function tagClassName(tag) {
    if (!tag) return 'none';
    switch (tag) {
        case '완조립': return 'assembly';
        case 'LED': return 'led';
        case 'CNC': return 'cnc';
        case '5층아크릴': return 'acrylic';
        default: return 'other';
    }
}
