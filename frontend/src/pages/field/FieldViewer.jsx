import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import { ALL_WORKERS } from '../../data/workers.js';
import './FieldViewer.css';

// 현장 PC 사이드바 뷰어 — Chrome --app=https://.../field 로 띄워 화면 한쪽에 박아두는 용도.
// 모바일 뷰어와 같은 endpoint(/api/public/worksheets, /worker-complete) 를 그대로 쓰고,
// [FS에서 열기] 만 로컬 에이전트(127.0.0.1) 에게 위임해 거래처 네트워크 폴더에서
// .fs 파일을 찾아 FlexiSIGN 으로 실행한다.

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const AGENT_URL = import.meta.env.VITE_HDSIGN_AGENT_URL || 'http://127.0.0.1:17345';
// 모바일/현장 공통 — 같은 PC 에서 둘 다 띄울 일이 거의 없지만 키 통일이 일관성에 좋다.
const WORKER_KEY = 'hdsign_uploader_worker';

function readWorker() {
    try { return (localStorage.getItem(WORKER_KEY) || '').trim(); } catch { return ''; }
}
function writeWorker(value) {
    try {
        if (value) localStorage.setItem(WORKER_KEY, value);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
}

function formatShortDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${d.getMonth() + 1}/${d.getDate()} (${dow})`;
}

function getDueBadge(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff < 0) return { kind: 'overdue', text: `${-diff}일 지남` };
    if (diff === 0) return { kind: 'today', text: '오늘' };
    if (diff === 1) return { kind: 'tomorrow', text: '내일' };
    return null;
}

export default function FieldViewer() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('active'); // 'active' | 'done'
    const [dateFilter, setDateFilter] = useState('all'); // 'all'|'overdue'|'today'|'3days'
    const [companyFilter, setCompanyFilter] = useState('ALL');
    const [searchTerm, setSearchTerm] = useState('');
    const [worker, setWorker] = useState(() => readWorker());
    const [showWorkerModal, setShowWorkerModal] = useState(false);
    const [workerDraft, setWorkerDraft] = useState('');
    const [openingFs, setOpeningFs] = useState(null);     // orderNumber 진행중
    const [completing, setCompleting] = useState(null);   // orderNumber 진행중
    const [toast, setToast] = useState(null);             // {kind, text}
    const aliveRef = useRef(true);

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
        } catch (err) {
            if (!aliveRef.current) return;
            setError(err.message || '오류가 발생했습니다.');
        } finally {
            if (!aliveRef.current) return;
            setLoading(false);
            if (manual) setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        aliveRef.current = true;
        fetchList();
        // 백→포 복귀 시 1회 새로고침. 현장 PC 는 항상 켜져 있어 자동 폴링은 불필요.
        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchList();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [fetchList]);

    const showToast = useCallback((kind, text, ms = 4000) => {
        setToast({ kind, text });
        window.setTimeout(() => setToast(null), ms);
    }, []);

    // 탭 분리 — 본인이 [완료] 누른 건은 '완료' 탭으로, 나머지는 '작업중'.
    // (사무실에서 정식 완료처리되면 status 가 COMPLETED 로 가서 LIST 응답에서 빠진다 = 자동으로 양 탭 모두에서 사라짐)
    const tabFiltered = useMemo(() => {
        return items.filter((it) => {
            const done = !!worker
                && Array.isArray(it.workerCompletions)
                && it.workerCompletions.some((c) => c.worker === worker);
            return tab === 'active' ? !done : done;
        });
    }, [items, tab, worker]);

    const dateFiltered = useMemo(() => {
        if (dateFilter === 'all') return tabFiltered;
        return tabFiltered.filter((it) => {
            if (typeof it.daysUntilDue !== 'number') return dateFilter === 'overdue' ? false : false;
            if (dateFilter === 'overdue') return it.daysUntilDue < 0;
            if (dateFilter === 'today') return it.daysUntilDue === 0;
            if (dateFilter === '3days') return it.daysUntilDue >= 0 && it.daysUntilDue <= 2;
            return true;
        });
    }, [tabFiltered, dateFilter]);

    const searchFiltered = useMemo(() => {
        const q = searchTerm.trim().toLowerCase();
        if (!q) return dateFiltered;
        return dateFiltered.filter((it) =>
            (it.companyName || '').toLowerCase().includes(q)
            || (it.title || '').toLowerCase().includes(q)
            || (it.orderNumber || '').toLowerCase().includes(q),
        );
    }, [dateFiltered, searchTerm]);

    const companyOptions = useMemo(() => {
        const counts = new Map();
        searchFiltered.forEach((it) => {
            if (it.companyName) counts.set(it.companyName, (counts.get(it.companyName) || 0) + 1);
        });
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }, [searchFiltered]);

    // 거래처 옵션 풀에서 선택값이 사라지면 자동 ALL 로 리셋.
    useEffect(() => {
        if (companyFilter === 'ALL') return;
        if (!companyOptions.some((c) => c.name === companyFilter)) setCompanyFilter('ALL');
    }, [companyFilter, companyOptions]);

    const filtered = useMemo(() => {
        if (companyFilter === 'ALL') return searchFiltered;
        return searchFiltered.filter((it) => it.companyName === companyFilter);
    }, [searchFiltered, companyFilter]);

    // 납기 임박 순. null 납기는 뒤로.
    const sorted = useMemo(() => {
        return [...filtered].sort((a, b) => {
            const ad = a.dueDate || '9999-12-31';
            const bd = b.dueDate || '9999-12-31';
            if (ad !== bd) return ad < bd ? -1 : 1;
            return (b.worksheetUpdatedAt || '').localeCompare(a.worksheetUpdatedAt || '');
        });
    }, [filtered]);

    const handleOpenFs = useCallback(async (it) => {
        if (!it.originalPdfFilename || !it.networkFolderName) {
            showToast(
                'warn',
                '아직 식별자가 없는 지시서입니다 — 워처가 새로 인쇄해야 [FS에서 열기]가 활성됩니다.',
                5000,
            );
            return;
        }
        setOpeningFs(it.orderNumber);
        try {
            // POST + 커스텀 헤더 — 단순 GET fetch 로는 다른 사이트가 트리거 못 하도록(에이전트가
            // X-HDSign-Field 헤더 필수 + Origin 화이트리스트 검사. preflight 강제.)
            const res = await fetch(`${AGENT_URL}/open`, {
                method: 'POST',
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json',
                    'X-HDSign-Field': '1',
                },
                body: JSON.stringify({ orderNumber: it.orderNumber }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || `에이전트 응답 ${res.status}`);
            }
            const body = await res.json();
            if (body.opened) {
                showToast('success', `FlexiSIGN 으로 여는 중… (${body.matchedFile || it.originalPdfFilename})`);
            } else {
                showToast('warn', body.message || '파일을 찾지 못해 거래처 폴더를 열었습니다.', 5000);
            }
        } catch {
            showToast(
                'error',
                '에이전트 연결 실패 — 트레이의 HD사인 작업뷰어 프로그램이 켜져있는지 확인하세요.',
                6000,
            );
        } finally {
            setOpeningFs(null);
        }
    }, [showToast]);

    const handleComplete = useCallback(async (it) => {
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        setCompleting(it.orderNumber);
        try {
            const res = await fetch(
                `${BASE_URL}/api/public/worksheets/${encodeURIComponent(it.orderNumber)}/worker-complete`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ worker }),
                },
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || '완료 신고 실패');
            }
            // 낙관적 갱신 — 다음 fetch 까지 기다리지 않고 즉시 탭 이동을 유도.
            const stamp = new Date().toISOString();
            setItems((prev) => prev.map((p) => p.orderNumber === it.orderNumber
                ? {
                    ...p,
                    workerCompletions: [
                        ...(p.workerCompletions || []),
                        { worker, completedAt: stamp },
                    ],
                }
                : p));
            showToast('success', '완료 신고 — 사무실에 알림이 갔습니다.');
        } catch (err) {
            showToast('error', err.message || '완료 신고 실패');
        } finally {
            setCompleting(null);
        }
    }, [worker, showToast]);

    const submitWorker = () => {
        const v = (workerDraft || '').trim();
        if (!v) return;
        setWorker(v);
        writeWorker(v);
        setShowWorkerModal(false);
    };

    const counts = useMemo(() => {
        let active = 0;
        let done = 0;
        items.forEach((it) => {
            const isDone = !!worker
                && Array.isArray(it.workerCompletions)
                && it.workerCompletions.some((c) => c.worker === worker);
            if (isDone) done += 1;
            else active += 1;
        });
        return { active, done };
    }, [items, worker]);

    return (
        <div className="fv-page">
            <header className="fv-header">
                <div className="fv-header-row">
                    <h1 className="fv-title">현장 지시서</h1>
                    <button
                        type="button"
                        className={`fv-refresh${refreshing ? ' spinning' : ''}`}
                        onClick={() => fetchList({ manual: true })}
                        disabled={refreshing}
                        aria-label="새로고침"
                    >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M13.5 8a5.5 5.5 0 1 1-1.611-3.889" />
                            <path d="M13.5 2.5v3h-3" />
                        </svg>
                        <span>{refreshing ? '갱신 중…' : '새로고침'}</span>
                    </button>
                </div>

                <div className="fv-tabs" role="tablist">
                    <button
                        role="tab"
                        type="button"
                        aria-selected={tab === 'active'}
                        className={`fv-tab${tab === 'active' ? ' on' : ''}`}
                        onClick={() => setTab('active')}
                    >
                        작업중 <span className="fv-tab-count">{counts.active}</span>
                    </button>
                    <button
                        role="tab"
                        type="button"
                        aria-selected={tab === 'done'}
                        className={`fv-tab${tab === 'done' ? ' on' : ''}`}
                        onClick={() => setTab('done')}
                    >
                        완료 <span className="fv-tab-count">{counts.done}</span>
                    </button>
                </div>

                <div className="fv-filters">
                    <select
                        className="fv-select"
                        value={dateFilter}
                        onChange={(e) => setDateFilter(e.target.value)}
                        aria-label="납기 필터"
                    >
                        <option value="all">전체 납기</option>
                        <option value="overdue">지난 납기</option>
                        <option value="today">오늘</option>
                        <option value="3days">3일내</option>
                    </select>
                    <select
                        className="fv-select"
                        value={companyFilter}
                        onChange={(e) => setCompanyFilter(e.target.value)}
                        aria-label="거래처 필터"
                    >
                        <option value="ALL">전체 거래처 ({searchFiltered.length})</option>
                        {companyOptions.map(({ name, count }) => (
                            <option key={name} value={name}>{name} ({count})</option>
                        ))}
                    </select>
                </div>

                <div className="fv-search">
                    <span className="fv-search-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="7" cy="7" r="4.5" />
                            <path d="M10.5 10.5L13.5 13.5" />
                        </svg>
                    </span>
                    <input
                        type="search"
                        className="fv-search-input"
                        placeholder="거래처/주문번호/제목 검색"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                    {searchTerm && (
                        <button
                            type="button"
                            className="fv-search-clear"
                            onClick={() => setSearchTerm('')}
                            aria-label="검색어 지우기"
                        >×</button>
                    )}
                </div>

                <div className="fv-worker-row">
                    <button
                        type="button"
                        className="fv-worker-chip"
                        onClick={() => { setWorkerDraft(worker || ''); setShowWorkerModal(true); }}
                    >
                        <span className="fv-worker-prefix">담당</span>
                        <span className="fv-worker-text">{worker || '미설정'}</span>
                    </button>
                </div>
            </header>

            <main className="fv-main">
                {loading && <div className="fv-empty">불러오는 중…</div>}
                {!loading && error && <div className="fv-empty error">{error}</div>}
                {!loading && !error && sorted.length === 0 && (
                    <div className="fv-empty">
                        {tab === 'done' ? '완료 처리한 지시서가 없습니다.' : '표시할 지시서가 없습니다.'}
                    </div>
                )}

                <div className="fv-cards">
                    {sorted.map((it) => {
                        const dueBadge = getDueBadge(it.dueDate);
                        const fsReady = !!(it.originalPdfFilename && it.networkFolderName);
                        const isCompleted = !!worker
                            && Array.isArray(it.workerCompletions)
                            && it.workerCompletions.some((c) => c.worker === worker);
                        const opening = openingFs === it.orderNumber;
                        const closing = completing === it.orderNumber;
                        return (
                            <article key={it.orderNumber} className="fv-card">
                                <div className="fv-card-thumb">
                                    <WorksheetThumbnail
                                        pdfUrl={it.worksheetPdfUrl}
                                        thumbnailUrl={it.worksheetThumbnailUrl}
                                    />
                                </div>
                                <div className="fv-card-body">
                                    <div className="fv-card-header">
                                        <div className="fv-card-company">{it.companyName || '거래처 미상'}</div>
                                        {dueBadge && (
                                            <span className={`fv-badge ${dueBadge.kind}`}>{dueBadge.text}</span>
                                        )}
                                    </div>
                                    <div className="fv-card-title" title={it.title || it.orderNumber}>
                                        {it.title || it.orderNumber}
                                    </div>
                                    <div className="fv-card-meta">
                                        {it.dueDate && (
                                            <span className="fv-card-due">납기 {formatShortDate(it.dueDate)}{it.dueTime ? ` ${it.dueTime}` : ''}</span>
                                        )}
                                        <span className="fv-card-no">{it.orderNumber}</span>
                                    </div>
                                    <div className="fv-card-actions">
                                        <button
                                            type="button"
                                            className="fv-btn fv-btn-fs"
                                            onClick={() => handleOpenFs(it)}
                                            disabled={!fsReady || opening}
                                            title={!fsReady
                                                ? '워처가 다음 인쇄로 갱신해야 활성됩니다(이전 업로드 건)'
                                                : 'FlexiSIGN 으로 열기'}
                                        >
                                            {opening ? '여는 중…' : 'FS에서 열기'}
                                        </button>
                                        {isCompleted ? (
                                            <span className="fv-btn fv-btn-completed" aria-disabled="true">
                                                완료됨
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="fv-btn fv-btn-done"
                                                onClick={() => handleComplete(it)}
                                                disabled={closing}
                                            >
                                                {closing ? '처리 중…' : '완료'}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            </main>

            {toast && (
                <div className={`fv-toast fv-toast-${toast.kind}`} role="status">
                    {toast.text}
                </div>
            )}

            {showWorkerModal && (
                <div className="fv-modal-bg" onClick={() => setShowWorkerModal(false)}>
                    <div className="fv-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>담당자 설정</h2>
                        <p className="fv-modal-desc">
                            이 PC 에서 작업하는 본인 이름을 한 번 선택하세요. [완료] 누를 때 누가 신고했는지 기록됩니다.
                        </p>
                        <div className="fv-chips">
                            {ALL_WORKERS.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={`fv-chip${workerDraft === name ? ' on' : ''}`}
                                    onClick={() => setWorkerDraft(name)}
                                >{name}</button>
                            ))}
                        </div>
                        <div className="fv-modal-actions">
                            <button
                                type="button"
                                className="fv-modal-cancel"
                                onClick={() => setShowWorkerModal(false)}
                            >취소</button>
                            <button
                                type="button"
                                className="fv-modal-confirm"
                                onClick={submitWorker}
                                disabled={!workerDraft.trim()}
                            >저장</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
