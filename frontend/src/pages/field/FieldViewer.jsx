import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import { ALL_WORKERS, matchesWorker } from '../../data/workers.js';
import './FieldViewer.css';

// 현장 PC 사이드바 뷰어 — Chrome --app=https://.../field 로 띄워 화면 한쪽에 박아두는 용도.
// 모바일 뷰어와 같은 endpoint(/api/public/worksheets, /worker-complete) 를 그대로 쓰고,
// [FS에서 열기] 만 로컬 에이전트(127.0.0.1) 에게 위임해 거래처 네트워크 폴더에서
// .fs 파일을 찾아 FlexiSIGN 으로 실행한다.

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const AGENT_URL = import.meta.env.VITE_HDSIGN_AGENT_URL || 'http://127.0.0.1:17345';
// 모바일/현장 공통 — 같은 PC 에서 둘 다 띄울 일이 거의 없지만 키 통일이 일관성에 좋다.
const WORKER_KEY = 'hdsign_uploader_worker';
// "내 지시서만 보기" 체크 상태 — 켜면 본인 부서 슬롯에 잡힌 지시서만 보임(미설정 시 기본 켜짐).
const MYONLY_KEY = 'hdsign_field_myonly';

function readWorker() {
    try { return (localStorage.getItem(WORKER_KEY) || '').trim(); } catch { return ''; }
}
function writeWorker(value) {
    try {
        if (value) localStorage.setItem(WORKER_KEY, value);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
}
function readMyOnly() {
    try {
        const v = localStorage.getItem(MYONLY_KEY);
        return v === null ? true : v === '1';   // 기본값: 켜짐
    } catch { return true; }
}
function writeMyOnly(value) {
    try { localStorage.setItem(MYONLY_KEY, value ? '1' : '0'); } catch { /* ignore */ }
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
    // 발주관리 '작업완료' 탭(=deletedAt != null) 의 주문들. 30일 후 스케줄러가 완전삭제.
    const [completedItems, setCompletedItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('active'); // 'active' | 'done'
    const [dateFilter, setDateFilter] = useState('all'); // 'all'|'overdue'|'today'|'3days'
    const [companyFilter, setCompanyFilter] = useState('ALL');
    const [searchTerm, setSearchTerm] = useState('');
    const [worker, setWorker] = useState(() => readWorker());
    const [myOnly, setMyOnly] = useState(() => readMyOnly());
    const [showWorkerModal, setShowWorkerModal] = useState(false);
    const [workerDraft, setWorkerDraft] = useState('');
    const [openingFs, setOpeningFs] = useState(null);     // orderNumber 진행중
    const [openingFolder, setOpeningFolder] = useState(null); // orderNumber 진행중
    const [completing, setCompleting] = useState(null);   // orderNumber 진행중
    const [toast, setToast] = useState(null);             // {kind, text}
    const [confirmAction, setConfirmAction] = useState(null); // {message, confirmText, onConfirm}
    const [selectedIndex, setSelectedIndex] = useState(-1);   // 키보드 선택 카드(검색→↓ 로 진입)
    const aliveRef = useRef(true);
    const cardsRef = useRef(null);
    const searchInputRef = useRef(null);

    const fetchList = useCallback(async ({ manual = false } = {}) => {
        if (manual) setRefreshing(true);
        try {
            // 작업중(IN_PROGRESS) + 작업완료(deletedAt != null) 를 병렬 fetch. 각각 별도 엔드포인트.
            const [activeRes, doneRes] = await Promise.all([
                fetch(`${BASE_URL}/api/public/worksheets?_=${Date.now()}`, { cache: 'no-store' }),
                fetch(`${BASE_URL}/api/public/worksheets/completed?_=${Date.now()}`, { cache: 'no-store' }),
            ]);
            if (!activeRes.ok) {
                const body = await activeRes.json().catch(() => ({}));
                throw new Error(body.message || '목록을 불러오지 못했습니다.');
            }
            if (!doneRes.ok) {
                const body = await doneRes.json().catch(() => ({}));
                throw new Error(body.message || '작업완료 목록을 불러오지 못했습니다.');
            }
            const [activeData, doneData] = await Promise.all([activeRes.json(), doneRes.json()]);
            if (!aliveRef.current) return;
            setItems(Array.isArray(activeData) ? activeData : []);
            setCompletedItems(Array.isArray(doneData) ? doneData : []);
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

    // 현장 뷰어 전용 — launcher.vbs 가 띄우는 브라우저 --app 창은 페이지 파비콘을
    // 작업표시줄/제목줄 아이콘으로 쓴다. 사이트 기본 파비콘(검정 HD 로고) 대신
    // 연파랑 로고로 바꿔, 사무실 지시서 프로그램과 헷갈리지 않게 한다.
    useEffect(() => {
        const prevTitle = document.title;
        document.title = 'HD사인 현장';
        const links = Array.from(document.querySelectorAll("link[rel~='icon']"));
        const restore = links.map((l) => ({ l, href: l.getAttribute('href'), type: l.getAttribute('type') }));
        let ours = links;
        if (ours.length === 0) {
            const l = document.createElement('link');
            l.setAttribute('rel', 'icon');
            document.head.appendChild(l);
            ours = [l];
        }
        ours.forEach((l) => {
            l.setAttribute('type', 'image/png');
            l.setAttribute('href', '/favicon-field-192.png');
        });
        return () => {
            document.title = prevTitle;
            restore.forEach(({ l, href, type }) => {
                if (href) l.setAttribute('href', href); else l.removeAttribute('href');
                if (type) l.setAttribute('type', type); else l.removeAttribute('type');
            });
        };
    }, []);

    useEffect(() => {
        aliveRef.current = true;
        fetchList();
        // 백→포 복귀(작업표시줄 클릭/창 활성화) 시 1회 새로고침 + 검색창 자동 포커스 — 바로 키보드 입력 가능.
        // 현장 PC 는 항상 켜져 있어 자동 폴링은 불필요.
        // 모달이 떠 있거나 카드를 키보드로 골라둔 상태에서는 포커스를 가로채지 않음(Enter 동작 깨짐 방지).
        const focusSearchSoon = () => {
            // 약간 지연 — 브라우저가 창 활성화 직후 처리하는 native focus 와 충돌하지 않도록.
            window.setTimeout(() => {
                const el = searchInputRef.current;
                if (!el) return;
                // 확인/담당자 모달이 떠 있으면 포커스 가로채지 않음(Enter 동작 깨짐 방지).
                if (document.querySelector('.fv-modal-bg')) return;
                el.focus();
                el.select?.();
            }, 50);
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                fetchList();
                focusSearchSoon();
            }
        };
        const onWindowFocus = () => focusSearchSoon();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onWindowFocus);
        // 초기 마운트에도 1회 포커스 — Chrome --app 으로 띄우자마자 키보드 입력 가능.
        focusSearchSoon();
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onWindowFocus);
        };
    }, [fetchList]);

    const showToast = useCallback((kind, text, ms = 4000) => {
        setToast({ kind, text });
        window.setTimeout(() => setToast(null), ms);
    }, []);

    // '내 지시서만 보기' 가 켜져 있고 담당자가 설정돼 있을 때만 본인 슬롯에 잡힌 것만 보여준다.
    // 끄면(또는 담당자 미설정) 전 부서 전체가 다 보인다.
    const effectiveMyOnly = myOnly && !!worker;
    // 작업중(IN_PROGRESS) — myOnly 면 본인 슬롯만, 아니면 전부.
    const visibleActive = useMemo(() => {
        if (!effectiveMyOnly) return items;
        return items.filter((it) => matchesWorker(it.departmentSlots, worker));
    }, [items, effectiveMyOnly, worker]);
    // 작업완료(발주관리 '작업완료' 탭과 동일 = deletedAt != null) — myOnly 면 본인 슬롯만, 아니면 전부.
    const visibleDone = useMemo(() => {
        if (!effectiveMyOnly) return completedItems;
        return completedItems.filter((it) => matchesWorker(it.departmentSlots, worker));
    }, [completedItems, effectiveMyOnly, worker]);

    // 탭 선택 — 작업중 / 완료. 본인이 [완료] 버튼을 눌렀는지 여부는 더 이상 탭 분기에 영향 없음.
    // (완료 신고는 백엔드 per-worker 기록 → 홈페이지 '작업현황' 탭만 갱신.)
    const tabFiltered = tab === 'active' ? visibleActive : visibleDone;

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

    // 정렬 — 작업중: 납기 임박순(null 납기는 뒤). 완료: 작업완료일(deletedAt) 최신순(없으면 worksheetUpdatedAt 폴백).
    const sorted = useMemo(() => {
        if (tab === 'done') {
            return [...filtered].sort((a, b) => {
                const ad = a.deletedAt || a.worksheetUpdatedAt || '';
                const bd = b.deletedAt || b.worksheetUpdatedAt || '';
                return bd.localeCompare(ad);
            });
        }
        return [...filtered].sort((a, b) => {
            const ad = a.dueDate || '9999-12-31';
            const bd = b.dueDate || '9999-12-31';
            if (ad !== bd) return ad < bd ? -1 : 1;
            return (b.worksheetUpdatedAt || '').localeCompare(a.worksheetUpdatedAt || '');
        });
    }, [filtered, tab]);

    // sorted 가 바뀌면(필터/검색/탭/새로고침) 선택 인덱스를 범위 안으로 정리.
    useEffect(() => {
        setSelectedIndex((i) => (i >= sorted.length ? -1 : i));
    }, [sorted.length]);

    // 검색어가 바뀌면 선택 해제 — 엉뚱한 카드가 강조된 채 남지 않도록.
    useEffect(() => { setSelectedIndex(-1); }, [searchTerm]);

    // 선택된 카드가 보이도록 스크롤.
    useEffect(() => {
        if (selectedIndex < 0) return;
        const el = cardsRef.current?.querySelector(`[data-card-index="${selectedIndex}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const handleOpenFs = useCallback(async (it) => {
        // 에이전트가 거래처 폴더를 찾는 키는 networkFolderName(우선) → companyName(폴백) 순 — 둘 다
        // 없을 일은 거의 없다. originalPdfFilename 이 없는 옛 건도 막지 않는다: 에이전트가 .fs
        // 자동매칭 대신 거래처 폴더만 열어주므로(버튼이 죽어있는 것보다 낫다).
        if (!(it.networkFolderName || it.companyName)) {
            showToast(
                'warn',
                '거래처 정보가 비어 있어 폴더를 찾을 수 없는 지시서입니다.',
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

    // [폴더열기] — 에이전트가 그 지시서의 .fs(찾으면) 가 든 폴더, 못 찾으면 거래처 폴더를 탐색기로 연다.
    const handleOpenFolder = useCallback(async (it) => {
        if (!(it.networkFolderName || it.companyName)) {
            showToast('warn', '거래처 정보가 비어 있어 폴더를 찾을 수 없는 지시서입니다.', 5000);
            return;
        }
        setOpeningFolder(it.orderNumber);
        try {
            const res = await fetch(`${AGENT_URL}/open-folder`, {
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
                showToast('success', body.message || '폴더를 열었습니다.');
            } else {
                showToast('warn', body.message || '폴더를 열지 못했습니다.', 5000);
            }
        } catch {
            showToast(
                'error',
                '에이전트 연결 실패 — 트레이의 HD사인 작업뷰어 프로그램이 켜져있는지 확인하세요.',
                6000,
            );
        } finally {
            setOpeningFolder(null);
        }
    }, [showToast]);

    // 키보드로 선택한 카드 열기 — 1차 Enter: 확인 모달, 2차 Enter: 실제 열기(모달 [열기] 버튼이 autoFocus).
    const askOpenFs = useCallback((it) => {
        if (!it) return;
        const fsReady = !!(it.networkFolderName || it.companyName);
        if (!fsReady) { handleOpenFs(it); return; }  // 거래처 정보 없음 → handleOpenFs 가 안내 토스트
        setConfirmAction({
            message: `[${it.title || it.orderNumber}] 작업지시서를 FlexiSIGN 에서 여시겠습니까?`,
            confirmText: '열기',
            onConfirm: () => handleOpenFs(it),
        });
    }, [handleOpenFs]);

    // fv-cards 영역(검색창에서 ↓ 로 진입)에서의 키 처리.
    const handleCardsKeyDown = useCallback((e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((i) => Math.min((i < 0 ? -1 : i) + 1, sorted.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((i) => {
                if (i <= 0) { searchInputRef.current?.focus(); return -1; }
                return i - 1;
            });
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0 && selectedIndex < sorted.length) {
                e.preventDefault();
                askOpenFs(sorted[selectedIndex]);
            }
        }
    }, [sorted, selectedIndex, askOpenFs]);

    const handleComplete = useCallback((it) => {
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        setConfirmAction({
            message: `[${it.title || it.orderNumber}] 완료하시겠습니까?`,
            confirmText: '완료',
            onConfirm: async () => {
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
                    // 낙관적 갱신 — 다음 fetch 까지 기다리지 않고 [완료]→[완료취소하기] 로 즉시 토글.
                    // (탭 이동 없음 — 완료 신고는 홈페이지 작업현황 탭만 갱신.)
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
            },
        });
    }, [worker, showToast]);

    const handleUncomplete = useCallback((it) => {
        if (!worker) return;
        setConfirmAction({
            message: `[${it.title || it.orderNumber}] 완료를 취소하시겠습니까?`,
            confirmText: '취소',
            onConfirm: async () => {
                setCompleting(it.orderNumber);
                try {
                    const res = await fetch(
                        `${BASE_URL}/api/public/worksheets/${encodeURIComponent(it.orderNumber)}/worker-uncomplete`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ worker }),
                        },
                    );
                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}));
                        throw new Error(body.message || '완료 취소 실패');
                    }
                    setItems((prev) => prev.map((p) => p.orderNumber === it.orderNumber
                        ? {
                            ...p,
                            workerCompletions: (p.workerCompletions || []).filter((c) => c.worker !== worker),
                        }
                        : p));
                    showToast('success', '완료를 취소했습니다.');
                } catch (err) {
                    showToast('error', err.message || '완료 취소 실패');
                } finally {
                    setCompleting(null);
                }
            },
        });
    }, [worker, showToast]);

    const submitWorker = () => {
        const v = (workerDraft || '').trim();
        if (!v) return;
        setWorker(v);
        writeWorker(v);
        setShowWorkerModal(false);
    };

    const counts = useMemo(() => ({
        active: visibleActive.length,
        done: visibleDone.length,
    }), [visibleActive, visibleDone]);

    const toggleMyOnly = useCallback(() => {
        const next = !myOnly;
        setMyOnly(next);
        writeMyOnly(next);
        // 켜려는데 담당자가 없으면 — 먼저 담당자부터 고르게 안내(설정 안 하면 필터가 무의미).
        if (next && !worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
        }
    }, [myOnly, worker]);

    return (
        <div className="fv-page">
            <header className="fv-header">
                <div className="fv-header-row">
                    <h1 className="fv-title">현장 지시서</h1>
                    <div className="fv-header-actions">
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
                        ref={searchInputRef}
                        type="search"
                        className="fv-search-input"
                        placeholder="거래처/주문번호/제목 검색 (↓ 로 목록 이동)"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                if (sorted.length > 0) {
                                    setSelectedIndex(0);
                                    cardsRef.current?.focus();
                                }
                            }
                        }}
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
                    <label className={`fv-myonly${myOnly ? ' on' : ''}`} title="끄면 타 부서 지시서까지 전체가 보입니다">
                        <input
                            type="checkbox"
                            checked={myOnly}
                            onChange={toggleMyOnly}
                        />
                        <span>내 지시서만 보기</span>
                    </label>
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
                        {tab === 'done' ? '작업완료된 지시서가 없습니다.' : '표시할 지시서가 없습니다.'}
                    </div>
                )}

                <div
                    className="fv-cards"
                    ref={cardsRef}
                    tabIndex={-1}
                    onKeyDown={handleCardsKeyDown}
                >
                    {sorted.map((it, idx) => {
                        const dueBadge = getDueBadge(it.dueDate);
                        // 거래처 폴더는 networkFolderName 우선·companyName 폴백으로 에이전트가 찾는다.
                        // 버튼 활성 조건은 그 둘 중 하나만 있으면 OK — originalPdfFilename 이 없는 옛 건은
                        // .fs 자동매칭 대신 거래처 폴더만 열림(에이전트가 처리).
                        const fsReady = !!(it.networkFolderName || it.companyName);
                        // originalPdfFilename 이 없으면(옛 건) 자동매칭 불가 — 버튼은 살리되 안내만 다르게.
                        const fsAutoMatch = fsReady && !!it.originalPdfFilename;
                        const isCompleted = !!worker
                            && Array.isArray(it.workerCompletions)
                            && it.workerCompletions.some((c) => c.worker === worker);
                        const opening = openingFs === it.orderNumber;
                        const openingDir = openingFolder === it.orderNumber;
                        const closing = completing === it.orderNumber;
                        return (
                            <article
                                key={it.orderNumber}
                                data-card-index={idx}
                                className={`fv-card${selectedIndex === idx ? ' selected' : ''}`}
                                onClick={() => setSelectedIndex(idx)}
                            >
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
                                    {it.title && (
                                        <div className="fv-card-title" title={it.title}>
                                            {it.title}
                                        </div>
                                    )}
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
                                                ? '거래처 정보가 비어 있어 폴더를 찾을 수 없습니다'
                                                : (fsAutoMatch
                                                    ? 'FlexiSIGN 으로 열기'
                                                    : '원본 PDF명이 없는 옛 건 — 누르면 거래처 폴더가 열립니다(.fs 직접 선택)')}
                                        >
                                            {opening ? '여는 중…' : 'FS에서 열기'}
                                        </button>
                                        <button
                                            type="button"
                                            className="fv-btn fv-btn-folder"
                                            onClick={() => handleOpenFolder(it)}
                                            disabled={!fsReady || openingDir}
                                            title={!fsReady
                                                ? '거래처 정보가 비어 있어 폴더를 찾을 수 없습니다'
                                                : '이 지시서의 .fs(찾으면) 가 든 폴더를 탐색기로 엽니다'}
                                        >
                                            {openingDir ? '여는 중…' : '폴더열기'}
                                        </button>
                                        {/* '완료'/'완료취소' 는 '작업중' 탭의 '내 지시서만 보기' 모드에서만.
                                            완료 신고는 홈페이지 '작업현황' 탭만 갱신하고 탭 분기에는 영향 없음.
                                            완료 탭(=발주관리 작업완료) 카드는 이미 사무실에서 마감된 작업이라 노출 X. */}
                                        {tab === 'active' && effectiveMyOnly && (isCompleted ? (
                                            <button
                                                type="button"
                                                className="fv-btn fv-btn-completed"
                                                onClick={() => handleUncomplete(it)}
                                                disabled={closing}
                                                title="누르면 완료를 취소할 수 있습니다"
                                            >
                                                {closing ? '처리 중…' : '완료취소하기'}
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                className="fv-btn fv-btn-done"
                                                onClick={() => handleComplete(it)}
                                                disabled={closing}
                                            >
                                                {closing ? '처리 중…' : '완료'}
                                            </button>
                                        ))}
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

            {confirmAction && (
                <div className="fv-modal-bg" onClick={() => setConfirmAction(null)}>
                    <div
                        className="fv-modal"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') setConfirmAction(null); }}
                    >
                        <p className="fv-modal-desc" style={{ fontSize: 16, color: '#1f2937' }}>
                            {confirmAction.message}
                        </p>
                        <div className="fv-modal-actions">
                            <button
                                type="button"
                                className="fv-modal-cancel"
                                onClick={() => setConfirmAction(null)}
                            >아니오</button>
                            <button
                                type="button"
                                className="fv-modal-confirm"
                                autoFocus
                                onClick={() => {
                                    const action = confirmAction.onConfirm;
                                    setConfirmAction(null);
                                    if (action) action();
                                }}
                            >{confirmAction.confirmText || '예'}</button>
                        </div>
                    </div>
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
