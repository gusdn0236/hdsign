import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetList.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

// 모바일 뷰어 부서 식별 — WorksheetViewer / EvidenceCapture 와 같은 키 공유.
// 휴대폰 단말 단위로 "이 폰은 어느 부서 폰" 으로 한 번 설정해두면 자동 적용.
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부', '후레임부'];
const MAX_DEPT_LEN = 100;

function getStoredDept() {
    try {
        const v = localStorage.getItem(DEPT_KEY);
        return v ? v.trim() : '';
    } catch {
        return '';
    }
}
function setStoredDept(value) {
    try {
        if (value) localStorage.setItem(DEPT_KEY, value);
        else localStorage.removeItem(DEPT_KEY);
    } catch { /* ignore */ }
}

function formatDateLabel(dateStr) {
    if (!dateStr) return '납기 미정';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const isToday = d.getTime() === today.getTime();
    const isTomorrow = d.getTime() === tomorrow.getTime();

    const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];

    if (isToday) return `오늘 · ${md} (${dow})`;
    if (isTomorrow) return `내일 · ${md} (${dow})`;
    return `${md} (${dow})`;
}

function getGroupKey(dateStr) {
    if (!dateStr) return 'none';
    return dateStr;
}

// 썸네일 — 보이기 시작할 때만 PDF 1페이지를 카드 폭에 맞춰 렌더.
// devicePixelRatio=1 + 텍스트/주석 레이어 끔 → "얼핏 보이는 정도" 의 가벼운 미리보기.
// memo + 안정 prop(pdfUrl 문자열) 로 60s 폴링/필터 토글 시 불필요 재렌더 차단.
const WorksheetThumbnail = memo(function WorksheetThumbnail({ pdfUrl }) {
    const ref = useRef(null);
    const [width, setWidth] = useState(0);
    const [visible, setVisible] = useState(false);
    const [errored, setErrored] = useState(false);

    useEffect(() => {
        if (!ref.current) return undefined;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const w = Math.floor(entry.contentRect.width);
                if (w > 0) setWidth((prev) => (prev === w ? prev : w));
            }
        });
        ro.observe(ref.current);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (visible || !ref.current) return undefined;
        const io = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setVisible(true);
                        io.disconnect();
                        break;
                    }
                }
            },
            // 화면 위/아래 400px 까지 미리 로딩 — 스크롤 시 빈 칸이 잠깐 보이는 걸 줄임.
            { rootMargin: '400px 0px' },
        );
        io.observe(ref.current);
        return () => io.disconnect();
    }, [visible]);

    const file = useMemo(() => (pdfUrl ? { url: pdfUrl } : null), [pdfUrl]);

    return (
        <div className="ws-thumb-frame" ref={ref}>
            {visible && file && width > 0 && !errored && (
                <Document
                    file={file}
                    loading={null}
                    error={null}
                    noData={null}
                    onLoadError={() => setErrored(true)}
                >
                    <Page
                        pageNumber={1}
                        width={width}
                        devicePixelRatio={1}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        loading={null}
                    />
                </Document>
            )}
            {errored && <div className="ws-thumb-err">미리보기 실패</div>}
        </div>
    );
});

export default function WorksheetList() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [dateFilter, setDateFilter] = useState('all'); // 'today' | '3days' | 'all'
    const [companyFilter, setCompanyFilter] = useState('ALL');
    // 체크 시 내 부서 태그가 붙은 지시서만 노출. 태그가 비어있는(워처 도입 이전) 지시서는
    // 자연스럽게 빠지므로 누락 방지 차원에서 기본은 off.
    const [mineOnly, setMineOnly] = useState(false);
    const [department, setDepartment] = useState(() => getStoredDept());
    const [showDeptModal, setShowDeptModal] = useState(false);
    const [deptDraft, setDeptDraft] = useState('');
    const [lastSyncedAt, setLastSyncedAt] = useState(null);
    const aliveRef = useRef(true);

    const myDept = department.trim();

    // mineOnly 체크했는데 부서 미설정이면 자동으로 부서 설정 모달을 띄워 준다.
    // 모달을 닫고 부서를 안 정하면 myDept 가 빈 문자열이라 결과는 off 와 동일하게 노출 — 동작 안전.
    useEffect(() => {
        if (mineOnly && !myDept) {
            setDeptDraft('');
            setShowDeptModal(true);
        }
    }, [mineOnly, myDept]);

    const submitDept = () => {
        const v = deptDraft.trim().slice(0, MAX_DEPT_LEN);
        if (!v) return;
        setDepartment(v);
        setStoredDept(v);
        setShowDeptModal(false);
    };

    const openDeptModal = () => {
        setDeptDraft(department || '');
        setShowDeptModal(true);
    };

    // 캐시버스터 + cache: no-store — 모바일/CDN 캐시로 인해 옛 데이터가 보이는 문제 방지.
    const fetchList = useCallback(async ({ manual = false } = {}) => {
        if (manual) setRefreshing(true);
        try {
            const res = await fetch(
                `${BASE_URL}/api/public/worksheets?_=${Date.now()}`,
                { cache: 'no-store' },
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || '목록을 불러오지 못했습니다.');
            }
            const data = await res.json();
            if (!aliveRef.current) return;
            setItems(Array.isArray(data) ? data : []);
            setError('');
            setLastSyncedAt(new Date());
        } catch (err) {
            if (!aliveRef.current) return;
            setError(err.message || '오류가 발생했습니다.');
        } finally {
            if (!aliveRef.current) return;
            setLoading(false);
            if (manual) setRefreshing(false);
        }
    }, []);

    // 캐시버스터(_v) 가 URL 에 남아 있으면 한 번 들어온 뒤 깨끗하게 제거.
    useEffect(() => {
        if (window.location.search.includes('_v=')) {
            const url = new URL(window.location.href);
            url.searchParams.delete('_v');
            window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        }
    }, []);

    useEffect(() => {
        aliveRef.current = true;
        fetchList();
        // 60초 폴링 + 백→포 복귀 시 즉시 재조회.
        const timer = setInterval(fetchList, 60000);
        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchList();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            aliveRef.current = false;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [fetchList]);

    const counts = useMemo(() => {
        let today = 0;
        let threeDays = 0;
        for (const it of items) {
            if (typeof it.daysUntilDue === 'number') {
                if (it.daysUntilDue === 0) today += 1;
                if (it.daysUntilDue >= 0 && it.daysUntilDue <= 2) threeDays += 1;
            }
        }
        return { today, threeDays, all: items.length };
    }, [items]);

    // 날짜 필터까지만 적용한 중간 결과 — 거래처 옵션의 건수도 이걸 기준으로 매김.
    const dateFilteredItems = useMemo(() => {
        if (dateFilter === 'all') return items;
        return items.filter((it) => {
            if (typeof it.daysUntilDue !== 'number') return false;
            if (dateFilter === 'today') return it.daysUntilDue === 0;
            if (dateFilter === '3days') return it.daysUntilDue >= 0 && it.daysUntilDue <= 2;
            return true;
        });
    }, [items, dateFilter]);

    // 거래처 옵션 — 날짜 필터에 걸린 항목만 모아서 카운트. 날짜 필터를 좁히면
    // 해당 거래처 건수도 자연스럽게 줄거나(0건이면 옵션이 사라짐) 그대로 유지.
    const companyOptions = useMemo(() => {
        const counts = new Map();
        dateFilteredItems.forEach((it) => {
            if (it.companyName) counts.set(it.companyName, (counts.get(it.companyName) || 0) + 1);
        });
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }, [dateFilteredItems]);

    // 선택해둔 거래처가 날짜 필터 변경으로 옵션에서 사라지면 자동으로 '전체' 로 리셋.
    useEffect(() => {
        if (companyFilter === 'ALL') return;
        if (!companyOptions.some((c) => c.name === companyFilter)) {
            setCompanyFilter('ALL');
        }
    }, [companyFilter, companyOptions]);

    const companyFilteredItems = useMemo(() => {
        if (companyFilter === 'ALL') return dateFilteredItems;
        return dateFilteredItems.filter((it) => it.companyName === companyFilter);
    }, [dateFilteredItems, companyFilter]);

    // mineOnly 가 true + 부서 설정됨일 때만 태그 매칭으로 좁힌다. 그 외엔 전체 통과.
    // 태그가 비어있는(워처 도입 이전) 지시서는 mineOnly 에서 빠지고 off 에서만 보여 누락 방지.
    const filtered = useMemo(() => {
        if (!mineOnly || !myDept) return companyFilteredItems;
        return companyFilteredItems.filter((it) =>
            Array.isArray(it.departmentTags) && it.departmentTags.includes(myDept)
        );
    }, [companyFilteredItems, mineOnly, myDept]);

    // 토글 라벨용 카운트(부서 태그가 붙은 지시서 개수).
    const myCount = useMemo(() => {
        if (!myDept) return 0;
        return companyFilteredItems.filter((it) =>
            Array.isArray(it.departmentTags) && it.departmentTags.includes(myDept)
        ).length;
    }, [companyFilteredItems, myDept]);

    const groups = useMemo(() => {
        const map = new Map();
        filtered.forEach((it) => {
            const key = getGroupKey(it.dueDate);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(it);
        });
        // 키 정렬 — 'none' 은 마지막
        return Array.from(map.entries()).sort(([a], [b]) => {
            if (a === 'none') return 1;
            if (b === 'none') return -1;
            return a.localeCompare(b);
        });
    }, [filtered]);

    const formatSyncedAt = (d) => {
        if (!d) return '';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    };

    return (
        <div className="ws-list-page">
            <header className="ws-list-header">
                <div className="ws-list-title-row">
                    <h1 className="ws-list-title">작업 지시서</h1>
                    <button
                        type="button"
                        className={`ws-refresh-btn ${refreshing ? 'spinning' : ''}`}
                        onClick={() => {
                            // PWA 의 "사파리 새로고침" 역할 — 쿼리 갱신 + replace 로 강제 리로드.
                            setRefreshing(true);
                            const url = new URL(window.location.href);
                            url.searchParams.set('_v', Date.now().toString());
                            window.location.replace(url.toString());
                        }}
                        disabled={refreshing}
                        aria-label="새로고침"
                    >
                        <span className="ws-refresh-icon" aria-hidden="true">⟳</span>
                        <span>{refreshing ? '갱신 중…' : '새로고침'}</span>
                    </button>
                </div>
                <p className="ws-list-meta">
                    <span className="ws-list-meta-count">{filtered.length}건</span>
                    <span className="ws-list-meta-sep">·</span>
                    <span>납기 임박 순</span>
                    {lastSyncedAt && (
                        <>
                            <span className="ws-list-meta-sep">·</span>
                            <span className="ws-list-meta-sync">갱신 {formatSyncedAt(lastSyncedAt)}</span>
                        </>
                    )}
                </p>

                <form className="ws-filter-form" onSubmit={(e) => e.preventDefault()}>
                    <label className="ws-filter-field">
                        <span className="ws-filter-label">납기일자</span>
                        <select
                            className="ws-filter-select"
                            value={dateFilter}
                            onChange={(e) => setDateFilter(e.target.value)}
                        >
                            <option value="today">오늘 ({counts.today})</option>
                            <option value="3days">3일내 ({counts.threeDays})</option>
                            <option value="all">전체 ({counts.all})</option>
                        </select>
                    </label>
                    <label className="ws-filter-field">
                        <span className="ws-filter-label">거래처</span>
                        <select
                            className="ws-filter-select"
                            value={companyFilter}
                            onChange={(e) => setCompanyFilter(e.target.value)}
                        >
                            <option value="ALL">전체 ({dateFilteredItems.length})</option>
                            {companyOptions.map(({ name, count }) => (
                                <option key={name} value={name}>{name} ({count})</option>
                            ))}
                        </select>
                    </label>
                </form>

                <div className="ws-personal-row">
                    <label className="ws-mine-toggle">
                        <input
                            type="checkbox"
                            className="ws-mine-checkbox"
                            checked={mineOnly}
                            onChange={(e) => setMineOnly(e.target.checked)}
                        />
                        <span className="ws-mine-text">
                            내 지시서만 보기
                            {myDept && <span className="ws-mine-count"> · {myCount}건</span>}
                        </span>
                    </label>
                    <button type="button" className="ws-dept-chip-btn" onClick={openDeptModal}>
                        <span className="ws-dept-chip-prefix">부서</span>
                        <span className="ws-dept-chip-text">{department || '미설정'}</span>
                    </button>
                </div>
            </header>

            {loading && <div className="ws-empty">불러오는 중…</div>}
            {!loading && error && <div className="ws-empty error">{error}</div>}
            {!loading && !error && filtered.length === 0 && (
                <div className="ws-empty">표시할 지시서가 없습니다.</div>
            )}

            {groups.map(([key, list]) => {
                const headerLabel = key === 'none' ? '납기 미정' : formatDateLabel(key);
                return (
                    <section className="ws-group" key={key}>
                        <h2 className="ws-group-head">
                            <span>{headerLabel}</span>
                            <span className="ws-group-count">{list.length}개</span>
                        </h2>
                        <div className="ws-grid">
                            {list.map((it) => (
                                <Link
                                    key={it.orderNumber}
                                    to={`/m/worksheets/${encodeURIComponent(it.orderNumber)}`}
                                    className="ws-grid-card"
                                >
                                    <WorksheetThumbnail pdfUrl={it.worksheetPdfUrl} />
                                    <div className="ws-thumb-company">
                                        {it.companyName || '거래처 미상'}
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                );
            })}

            {showDeptModal && (
                <div
                    className="ws-dept-modal-backdrop"
                    onClick={() => {
                        // 부서 미설정 상태에서 백드롭 클릭으로 닫으면 mineOnly 자동 해제 — 무한 모달 방지.
                        setShowDeptModal(false);
                        if (!department && mineOnly) setMineOnly(false);
                    }}
                >
                    <div className="ws-dept-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>내 부서 설정</h2>
                        <p className="ws-dept-modal-desc">
                            이 휴대폰을 사용하는 부서를 선택하세요. "내 지시서만 보기"에서 해당 부서 태그가 붙은 지시서만 보입니다.
                        </p>
                        <div className="ws-dept-quick-chips">
                            {QUICK_DEPTS.map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    className={`ws-dept-quick-chip ${deptDraft === d ? 'active' : ''}`}
                                    onClick={() => setDeptDraft(d)}
                                >{d}</button>
                            ))}
                        </div>
                        <input
                            type="text"
                            className="ws-dept-modal-input"
                            placeholder="직접 입력"
                            value={deptDraft}
                            maxLength={MAX_DEPT_LEN}
                            onChange={(e) => setDeptDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submitDept(); }}
                            autoFocus
                        />
                        <div className="ws-dept-modal-actions">
                            <button
                                type="button"
                                className="ws-dept-modal-cancel"
                                onClick={() => {
                                    setShowDeptModal(false);
                                    if (!department && mineOnly) setMineOnly(false);
                                }}
                            >취소</button>
                            <button
                                type="button"
                                className="ws-dept-modal-confirm"
                                onClick={submitDept}
                                disabled={!deptDraft.trim()}
                            >저장</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
