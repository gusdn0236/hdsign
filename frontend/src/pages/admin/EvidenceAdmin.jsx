import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import KakaoShareButton from '../../components/common/KakaoShareButton.jsx';
import { safeFileName } from '../../utils/shareImage.js';
import './EvidenceAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const PAGE_SIZE = 60;
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DEFAULT_TAGS = ['완조립', 'LED', 'CNC', '5층아크릴'];

// 갤러리 등록 시 선택할 카테고리 — GalleryUpload 와 동일하게 유지. 추후 GalleryUpload 와
// 공유 상수로 옮기는 게 좋지만 지금은 두 파일에서만 쓰이고 변경 빈도가 낮아 중복 허용.
const GALLERY_CATEGORIES = {
    galva:     { label: '갈바채널',    subCategories: ['갈바 전/후광', '갈바 오사이', '갈바 측광'] },
    stainless: { label: '스텐채널',    subCategories: ['스텐 전/후광', '스텐 오사이', '스텐 측광', '골드스텐'] },
    epoxy:     { label: '에폭시채널',   subCategories: ['갈바 에폭시', '스텐에폭시'] },
    aluminum:  { label: '알미늄채널',   subCategories: ['타카채널', '일체형채널'] },
    artneon:   { label: '아트네온',    subCategories: ['아크릴네온', '아크릴조각사인'] },
    special:   { label: '특수/기타 가공물', subCategories: ['프레임간판', '지주간판', '아크릴/포맥스', '고무스카시'] },
};

function formatTime(s) {
    if (!s) return '';
    try {
        const d = new Date(s);
        const h = d.getHours();
        const mi = d.getMinutes();
        const period = h < 12 ? '오전' : '오후';
        // 12시간제 — 0시는 오전 12시, 12시는 오후 12시, 그 외 13~23 은 -12
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${period} ${h12}시 ${mi}분`;
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

function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    const fixed = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(fixed)} ${units[i]}`;
}

function DriveUsageBar({ usage, onRefresh }) {
    if (!usage || usage.enabled === false) {
        return (
            <div className="drive-usage drive-usage--off">
                <span className="drive-usage-title">구글 드라이브 백업 <span className="drive-usage-server">(Google Drive)</span></span>
                <span className="drive-usage-msg">백업 비활성화 상태</span>
            </div>
        );
    }
    if (usage.error) {
        return (
            <div className="drive-usage drive-usage--off">
                <div className="drive-usage-head">
                    <span className="drive-usage-title">구글 드라이브 백업 <span className="drive-usage-server">(Google Drive)</span></span>
                    <span className="drive-usage-msg">사용량 조회 실패</span>
                    <button type="button" className="drive-usage-refresh" onClick={onRefresh} title="다시 시도">↻</button>
                </div>
                {/* 실제 원인(invalid_grant 등)을 관리자에게 노출 — "조회 실패"만 보면 진단 불가. */}
                <div className="drive-usage-hint" title={String(usage.error)}>{String(usage.error)}</div>
            </div>
        );
    }
    const usageBytes = Number(usage.usage ?? 0);
    const limitBytes = Number(usage.limit ?? 0);
    const unlimited = Boolean(usage.unlimited);
    const percent = Math.min(100, Number(usage.percent ?? 0));
    const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok';
    return (
        <div className={`drive-usage drive-usage--${tone}`}>
            <div className="drive-usage-head">
                <span className="drive-usage-title">
                    구글 드라이브 백업 <span className="drive-usage-server">(Google Drive)</span>
                </span>
                <span className="drive-usage-amount">
                    <b>{formatBytes(usageBytes)}</b>
                    {unlimited
                        ? <> / 무제한</>
                        : <> / {formatBytes(limitBytes)} ({percent.toFixed(1)}%)</>
                    }
                </span>
                <button
                    type="button"
                    className="drive-usage-refresh"
                    onClick={onRefresh}
                    title="다시 측정 (60초 캐시)"
                >↻</button>
            </div>
            {!unlimited && (
                <div className="drive-usage-track" role="progressbar"
                     aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                    <div className="drive-usage-fill" style={{ width: `${percent}%` }} />
                </div>
            )}
            {usage.accountEmail && (
                <div className="drive-usage-foot">
                    계정: <span>{usage.accountEmail}</span>
                    {usage.rootFolderName && <> · 폴더: <span>{usage.rootFolderName}</span></>}
                </div>
            )}
            {tone === 'danger' && (
                <div className="drive-usage-hint">한도의 90% 를 초과했습니다. 드라이브에서 직접 정리하거나 플랜 업그레이드를 고려하세요.</div>
            )}
            {tone === 'warn' && (
                <div className="drive-usage-hint">한도의 70% 를 넘었습니다. 곧 정리를 권장합니다.</div>
            )}
        </div>
    );
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

    // 갤러리 등록 패널 — 라이트박스 안에서 열림. 한 번에 한 사진만 등록.
    const [galleryPanel, setGalleryPanel] = useState(null); // { category, subCategory } | null
    const [gallerySubmitting, setGallerySubmitting] = useState(false);
    const [galleryFeedback, setGalleryFeedback] = useState(null); // { type:'success'|'error', msg }

    // 선택 모드 + 선택된 ID 셋
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState(() => new Set());
    const [deleting, setDeleting] = useState(false);

    // 드라이브 저장공간
    const [driveUsage, setDriveUsage] = useState(null);
    const loadDriveUsage = useCallback(() => {
        fetch(`${BASE_URL}/api/admin/storage/drive-usage`, { headers: authHeader })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => setDriveUsage(d))
            .catch(() => setDriveUsage(null));
    }, [authHeader]);
    useEffect(() => { loadDriveUsage(); }, [loadDriveUsage]);

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

    // 라이트박스가 닫히거나 다른 사진으로 이동하면 갤러리 패널/피드백 초기화.
    useEffect(() => {
        setGalleryPanel(null);
        setGalleryFeedback(null);
    }, [lightboxIndex]);

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

    const openGalleryPanel = () => {
        const firstCat = Object.keys(GALLERY_CATEGORIES)[0];
        setGalleryPanel({
            category: firstCat,
            subCategory: GALLERY_CATEGORIES[firstCat].subCategories[0],
        });
        setGalleryFeedback(null);
    };
    const updateGalleryCategory = (cat) => {
        setGalleryPanel((prev) => prev ? {
            category: cat,
            subCategory: GALLERY_CATEGORIES[cat].subCategories[0],
        } : prev);
    };
    const updateGallerySub = (sub) => {
        setGalleryPanel((prev) => prev ? { ...prev, subCategory: sub } : prev);
    };
    const submitGallery = async (item) => {
        if (!item || !galleryPanel) return;
        setGallerySubmitting(true);
        setGalleryFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/evidence/${item.id}/add-to-gallery`, {
                method: 'POST',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: galleryPanel.category, subCategory: galleryPanel.subCategory }),
            });
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                throw new Error(b.message || '갤러리 등록 실패');
            }
            const catLabel = GALLERY_CATEGORIES[galleryPanel.category]?.label || galleryPanel.category;
            setGalleryFeedback({ type: 'success', msg: `${catLabel} > ${galleryPanel.subCategory} 에 등록되었습니다.` });
            setGalleryPanel(null);
        } catch (err) {
            setGalleryFeedback({ type: 'error', msg: err.message || '갤러리 등록 실패' });
        } finally {
            setGallerySubmitting(false);
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

            <DriveUsageBar usage={driveUsage} onRefresh={loadDriveUsage} />

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
                                    <div
                                        key={it.id}
                                        role="button"
                                        tabIndex={0}
                                        className={`evidence-card${isChecked ? ' selected' : ''}`}
                                        onClick={handleClick}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleClick();
                                            }
                                        }}
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
                                            {!selectMode && (
                                                <KakaoShareButton
                                                    className="evidence-card-share"
                                                    iconOnly
                                                    getSource={() => ({ type: 'url', url: it.fileUrl })}
                                                    fileName={() => safeFileName(
                                                        it.originalName
                                                        || `${it.companyName || '현장사진'}_${it.orderNumber || ''}`,
                                                    )}
                                                />
                                            )}
                                            <span className="evidence-card-time-badge">{formatTime(it.createdAt)}</span>
                                            {it.fileSize > 0 && (
                                                <span className="evidence-card-size-badge">{formatBytes(it.fileSize)}</span>
                                            )}
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
                                    </div>
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

                            {/* 카카오톡 공유 — PC 는 클립보드 복사, 모바일은 공유 시트 */}
                            <div className="evidence-lightbox-share-row">
                                <KakaoShareButton
                                    className="evidence-lightbox-share"
                                    getSource={() => ({ type: 'url', url: active.fileUrl })}
                                    fileName={() => safeFileName(
                                        active.originalName
                                        || `${active.companyName || '현장사진'}_${active.orderNumber || ''}`,
                                    )}
                                />
                            </div>

                            {/* 갤러리 등록 영역 */}
                            <div className="evidence-gallery-section">
                                {galleryFeedback && (
                                    <div className={`evidence-gallery-feedback ${galleryFeedback.type}`}>
                                        {galleryFeedback.type === 'success' ? '✓ ' : '⚠ '}
                                        {galleryFeedback.msg}
                                    </div>
                                )}
                                {!galleryPanel ? (
                                    <button
                                        type="button"
                                        className="evidence-gallery-open-btn"
                                        onClick={openGalleryPanel}
                                    >
                                        + 갤러리에 추가
                                    </button>
                                ) : (
                                    <div className="evidence-gallery-panel">
                                        <label className="evidence-gallery-label">
                                            <span>카테고리</span>
                                            <select
                                                value={galleryPanel.category}
                                                onChange={(e) => updateGalleryCategory(e.target.value)}
                                                disabled={gallerySubmitting}
                                            >
                                                {Object.entries(GALLERY_CATEGORIES).map(([key, val]) => (
                                                    <option key={key} value={key}>{val.label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="evidence-gallery-label">
                                            <span>세부 분류</span>
                                            <select
                                                value={galleryPanel.subCategory}
                                                onChange={(e) => updateGallerySub(e.target.value)}
                                                disabled={gallerySubmitting}
                                            >
                                                {GALLERY_CATEGORIES[galleryPanel.category].subCategories.map((s) => (
                                                    <option key={s} value={s}>{s}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <div className="evidence-gallery-actions">
                                            <button
                                                type="button"
                                                className="evidence-gallery-cancel"
                                                onClick={() => setGalleryPanel(null)}
                                                disabled={gallerySubmitting}
                                            >취소</button>
                                            <button
                                                type="button"
                                                className="evidence-gallery-confirm"
                                                onClick={() => submitGallery(active)}
                                                disabled={gallerySubmitting}
                                            >{gallerySubmitting ? '등록 중…' : '등록'}</button>
                                        </div>
                                    </div>
                                )}
                            </div>
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
