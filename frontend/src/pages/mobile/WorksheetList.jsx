import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import { ALL_WORKERS, matchesWorker } from '../../data/workers.js';
import { getStoredWorker, setStoredWorker } from '../../data/workerStorage.js';
import { applyPushMode, getStoredPushMode, isPushSupported } from '../../utils/push.js';
import { rememberAllListItems } from './pdfPrefetch.js';
import './WorksheetList.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
let worksheetListSnapshot = {
    items: null,
    completedItems: null,
    syncedAt: null,
    scrollY: 0,
    dateFilter: 'all',
    companyFilter: 'ALL',
    companySearch: '',
    // 'due' = 진행중 지시서를 납기 임박순 그룹.
    // 'completed' = 발주관리 [작업완료] 탭(=deletedAt != null) 의 마감 건들을 완료일자 그룹으로.
    sortMode: 'due',
};

function rememberWorksheetListView(patch = {}) {
    worksheetListSnapshot = {
        ...worksheetListSnapshot,
        scrollY: window.scrollY || 0,
        ...patch,
    };
}

let worksheetViewerPreloadPromise = null;
function preloadWorksheetViewerChunk(immediate = false) {
    if (worksheetViewerPreloadPromise) return worksheetViewerPreloadPromise;
    const load = () => {
        worksheetViewerPreloadPromise = import('./WorksheetViewer.jsx').catch((err) => {
            worksheetViewerPreloadPromise = null;
            throw err;
        });
        return worksheetViewerPreloadPromise;
    };
    if (immediate) return load();
    if (typeof window !== 'undefined' && window.requestIdleCallback) {
        window.requestIdleCallback(load, { timeout: 1800 });
    } else {
        window.setTimeout(load, 600);
    }
    return null;
}

// "내 지시서만 보기" 를 사용자가 명시적으로 푼 직원 이름. 담당자가 설정되어 있으면 default 는 ON 이지만,
// 한 번 풀고 나면 다시 켜기 전까지는 OFF 유지(workerName 저장으로 직원이 바뀌면 다시 default ON).
const MINE_OFF_KEY = 'hdsign_mine_off_worker';

// "내 지시서만 보기 + 작업완료건도 보이기" 토글 — 기본 OFF(=완료건 숨김).
// mineOnly OFF 일 때는 전체 노출(완료건도 리본만 띄워 보임)이라 이 토글은 mineOnly ON 일 때만 동작.
const SHOW_COMPLETED_KEY = 'hdsign_show_completed_mine';

function getStoredMineOffWorker() {
    try {
        const v = localStorage.getItem(MINE_OFF_KEY);
        return v ? v.trim() : '';
    } catch {
        return '';
    }
}
function setStoredMineOffWorker(value) {
    try {
        if (value) localStorage.setItem(MINE_OFF_KEY, value);
        else localStorage.removeItem(MINE_OFF_KEY);
    } catch { /* ignore */ }
}
function getStoredShowCompleted() {
    try { return localStorage.getItem(SHOW_COMPLETED_KEY) === '1'; }
    catch { return false; }
}
function setStoredShowCompleted(value) {
    try {
        if (value) localStorage.setItem(SHOW_COMPLETED_KEY, '1');
        else localStorage.removeItem(SHOW_COMPLETED_KEY);
    } catch { /* ignore */ }
}

// 그룹 헤더용: '5월 6일 (수)'. 올해가 아니면 앞에 연도(예: '2027년 5월 7일 (금)') —
// 거래처 발주 폼에서 연도 오타로 들어온 미래 납기가 "올해의 5월 7일" 처럼 보여
// 이미 지난 작업으로 착각되던 문제 방지(주문-260506-15 사례).
function formatDueDateLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const yearPrefix = d.getFullYear() !== new Date().getFullYear()
        ? `${d.getFullYear()}년 ` : '';
    const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${yearPrefix}${md} (${dow})`;
}

// 납기 상태 배지 — 오늘/내일/지남 만. 일반 미래 일자는 null 반환(헤더 날짜만 보임).
function getDueBadge(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return { kind: 'overdue', text: `${-diffDays}일 지남` };
    if (diffDays === 0) return { kind: 'today', text: '오늘' };
    if (diffDays === 1) return { kind: 'tomorrow', text: '내일' };
    return null;
}

function getGroupKey(dateStr) {
    if (!dateStr) return 'none';
    return dateStr;
}

// 완료일(timestamp) 그룹 헤더용 — '5월 6일 (수) 완료'. 올해가 아니면 연도 노출.
function formatCompletedDateLabel(dateStr) {
    if (!dateStr) return '완료일 미상';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const yearPrefix = d.getFullYear() !== new Date().getFullYear()
        ? `${d.getFullYear()}년 ` : '';
    const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${yearPrefix}${md} (${dow})`;
}

// '5/14' 형식의 짧은 완료일. 올해가 아니면 'YYYY/M/D'.
function formatCompletedShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return d.getFullYear() !== new Date().getFullYear()
        ? `${d.getFullYear()}/${md}` : md;
}

// 완료일 → 'X일 전' 라벨(7일 초과면 날짜 노출). 그룹 헤더 보조 표시용.
function formatCompletedRelative(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const diffDays = Math.floor((Date.now() - t) / 86400000);
    if (diffDays <= 0) return '오늘';
    if (diffDays === 1) return '어제';
    if (diffDays < 7) return `${diffDays}일 전`;
    return formatCompletedShort(iso);
}

// ISO timestamp(2026-05-14T12:34:56...) → 그룹 키로 쓸 'YYYY-MM-DD'.
function getCompletedGroupKey(iso) {
    if (!iso) return 'none';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'none';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

export default function WorksheetList() {
    const [items, setItems] = useState(() => worksheetListSnapshot.items || []);
    // 발주관리 [작업완료] 탭(=deletedAt != null) 의 마감 건들. 30일 후 자동 삭제 전까지 남아 있음.
    const [completedItems, setCompletedItems] = useState(() => worksheetListSnapshot.completedItems || []);
    const [loading, setLoading] = useState(() => !worksheetListSnapshot.items);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [dateFilter, setDateFilter] = useState(() => worksheetListSnapshot.dateFilter); // 'today' | '3days' | 'all'
    const [companyFilter, setCompanyFilter] = useState(() => worksheetListSnapshot.companyFilter);
    const [companySearch, setCompanySearch] = useState(() => worksheetListSnapshot.companySearch);
    // 'due' = 진행중 지시서를 납기 임박순 날짜 그룹.
    // 'completed' = 발주관리 [작업완료] 처리된 작업건들을 완료일자 그룹으로(최신 일자가 위).
    const [sortMode, setSortMode] = useState(() => worksheetListSnapshot.sortMode);
    // 체크 시 본인 슬롯에 매핑된 지시서만 노출 + 본인이 [작업완료] 누른 건 자동 제외(per-worker).
    // 담당자가 있으면 default = ON. 사용자가 직접 풀면 그 직원 이름이 MINE_OFF_KEY 에 저장되어
    // 다음 진입에도 OFF 유지. 직원이 바뀌면 자동으로 default ON 복귀(이전 OFF 키와 다른 이름이라).
    const [worker, setWorker] = useState(() => getStoredWorker());
    const [mineOnly, setMineOnly] = useState(() => {
        const w = getStoredWorker();
        if (!w) return false;
        return getStoredMineOffWorker() !== w;
    });
    // 내 지시서만 보기에서 본인 완료건도 함께 노출할지(완료 리본 그대로) — 기본 OFF.
    const [showCompleted, setShowCompleted] = useState(() => getStoredShowCompleted());
    const [showWorkerModal, setShowWorkerModal] = useState(false);
    const [workerDraft, setWorkerDraft] = useState('');
    // 지시서 변경 알림 설정 — 'all' | 'mine' | 'off'.
    const [showPushModal, setShowPushModal] = useState(false);
    const [pushMode, setPushMode] = useState(() => getStoredPushMode());
    const [pushBusy, setPushBusy] = useState(false);
    const [pushMsg, setPushMsg] = useState('');
    const [lastSyncedAt, setLastSyncedAt] = useState(() => worksheetListSnapshot.syncedAt);
    // 거래처 검색줄 포커스 여부 — 포커스 링 스타일용.
    const [searchFocused, setSearchFocused] = useState(false);
    const aliveRef = useRef(true);

    const myWorker = worker.trim();

    useEffect(() => {
        worksheetListSnapshot = {
            ...worksheetListSnapshot,
            dateFilter,
            companyFilter,
            companySearch,
            sortMode,
        };
    }, [dateFilter, companyFilter, companySearch, sortMode]);

    useLayoutEffect(() => {
        if (!worksheetListSnapshot.items) return undefined;
        let cancelled = false;
        const restore = () => {
            if (!cancelled) window.scrollTo({ top: worksheetListSnapshot.scrollY || 0 });
        };
        requestAnimationFrame(() => requestAnimationFrame(restore));
        return () => {
            cancelled = true;
            rememberWorksheetListView();
        };
    }, []);

    // mineOnly 체크했는데 직원 미설정이면 자동으로 설정 모달을 띄워 준다.
    // 모달을 닫고 안 정하면 myWorker 가 빈 문자열이라 결과는 off 와 동일하게 노출 — 동작 안전.
    useEffect(() => {
        if (mineOnly && !myWorker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
        }
    }, [mineOnly, myWorker]);

    const submitWorker = () => {
        const v = workerDraft.trim();
        if (!v) return;
        setWorker(v);
        setStoredWorker(v);
        // 직원이 바뀌었거나 새로 설정된 시점 — mineOnly off 마커는 그 직원 한정이라 초기화하고
        // mineOnly 자동 ON 으로 복귀("담당자가 선택되었다면 항상 체크" 정책).
        setStoredMineOffWorker('');
        setMineOnly(true);
        setShowWorkerModal(false);
    };

    const handlePushModeChange = async (mode) => {
        setPushBusy(true);
        setPushMsg('');
        const result = await applyPushMode(mode, myWorker);
        setPushMode(result.mode);
        if (!result.ok && result.message) setPushMsg(result.message);
        setPushBusy(false);
    };

    // mineOnly 사용자 토글 — 풀면 MINE_OFF_KEY 에 현재 worker 저장, 켜면 키 제거.
    // 직원 미설정인데 켜면 모달 띄우는 기존 useEffect 가 그대로 동작.
    const handleMineToggle = (next) => {
        setMineOnly(next);
        if (!next && worker) {
            setStoredMineOffWorker(worker);
        } else {
            setStoredMineOffWorker('');
        }
    };

    const handleShowCompletedToggle = (next) => {
        setShowCompleted(next);
        setStoredShowCompleted(next);
    };

    const openWorkerModal = () => {
        setWorkerDraft(worker || '');
        setShowWorkerModal(true);
    };

    // 캐시버스터 + cache: no-store — 모바일/CDN 캐시로 인해 옛 데이터가 보이는 문제 방지.
    // 진행중(/worksheets) + 완료(/worksheets/completed) 를 병렬 fetch. 완료 fetch 실패는
    // 진행중 흐름을 막지 않는다(완료작업건 탭은 빈 화면 폴백).
    const fetchList = useCallback(async ({ manual = false } = {}) => {
        if (manual) setRefreshing(true);
        try {
            const [activeRes, doneRes] = await Promise.all([
                fetch(`${BASE_URL}/api/public/worksheets?_=${Date.now()}`, { cache: 'no-store' }),
                fetch(`${BASE_URL}/api/public/worksheets/completed?_=${Date.now()}`, { cache: 'no-store' }),
            ]);
            if (!activeRes.ok) {
                const body = await activeRes.json().catch(() => ({}));
                throw new Error(body.message || '목록을 불러오지 못했습니다.');
            }
            const data = await activeRes.json();
            const doneData = doneRes.ok ? await doneRes.json().catch(() => []) : [];
            if (!aliveRef.current) return;
            const nextItems = Array.isArray(data) ? data : [];
            const nextCompleted = Array.isArray(doneData) ? doneData : [];
            worksheetListSnapshot = {
                ...worksheetListSnapshot,
                items: nextItems,
                completedItems: nextCompleted,
                syncedAt: new Date(),
            };
            setItems(nextItems);
            setCompletedItems(nextCompleted);
            setError('');
            setLastSyncedAt(worksheetListSnapshot.syncedAt);
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
        // 자동 폴링 없음 — 모바일 데이터 절약 목적. 두 자연 트리거 + 수동 새로고침만 사용:
        //  1) 앱 첫 마운트 시 1회 (위 fetchList())
        //  2) 백→포 복귀 시 1회 (visibilitychange) — 직원이 다른 앱 갔다 돌아오면 자동 반영
        //  3) 헤더 [새로고침] 버튼 — 워처가 방금 인쇄해서 즉시 보고 싶을 때
        // 워처 인쇄 빈도가 분 단위라 60초 폴링은 과했고, 직원 사용 패턴(앱→작업→앱 왕복)
        // 에서는 visibilitychange 가 자주 발생해 폴링 없이도 최신 상태 유지가 잘 됨.
        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchList();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [fetchList]);

    // 목록이 갱신될 때마다:
    //  1) 모든 항목의 detail 을 메모리 캐시에 저장 — 사용자가 어떤 카드를 탭해도 뷰어 진입
    //     시점에 회사명/제목/납기/PDF URL 이 이미 채워져 있어 첫 화면 빈공간이 없음.
    //  2) idle 시간에 뷰어 코드 청크를 미리 import — 탭 시 JS 번들 로드 대기시간 제거.
    // PDF 자체는 미리 받지 않는다 — sw.js 가 Range 를 우회하므로 byte-range 워밍은
    // 캐시에 못 들어가고 PDF.js 의 실제 fetch 와 경합만 한다. PDF 는 PDF.js + 브라우저
    // HTTP 캐시(?v= long max-age) + SW 의 자연 경로에 맡긴다.
    // 완료작업건도 동일하게 detail 캐시에 저장 — 완료 카드 탭 시 PDF 뷰어가 빈 화면 없이 즉시 표시.
    useEffect(() => {
        const all = [...(items || []), ...(completedItems || [])];
        if (all.length === 0) return;
        rememberAllListItems(all);
        preloadWorksheetViewerChunk(false);
    }, [items, completedItems]);

    // 활성 source — 'due' 는 진행중, 'completed' 는 발주관리 [작업완료] 처리된 마감 건.
    const activeSource = sortMode === 'completed' ? completedItems : items;

    // 날짜 필터까지만 적용한 중간 결과 — 거래처 옵션의 건수도 이걸 기준으로 매김.
    // 완료작업건 모드는 dueDate 대신 deletedAt 기준이라 '오늘/3일내' 필터를 적용하지 않는다(전체).
    const dateFilteredItems = useMemo(() => {
        if (sortMode === 'completed' || dateFilter === 'all') return activeSource;
        return activeSource.filter((it) => {
            if (typeof it.daysUntilDue !== 'number') return false;
            if (dateFilter === 'today') return it.daysUntilDue === 0;
            if (dateFilter === '3days') return it.daysUntilDue >= 0 && it.daysUntilDue <= 2;
            return true;
        });
    }, [activeSource, dateFilter, sortMode]);

    // 검색어로 한 번 더 좁힌 결과 — 거래처 드롭다운/카운트도 이걸 기준으로 한다.
    const searchFilteredItems = useMemo(() => {
        const term = companySearch.trim().toLowerCase();
        if (!term) return dateFilteredItems;
        return dateFilteredItems.filter((it) =>
            (it.companyName || '').toLowerCase().includes(term)
        );
    }, [dateFilteredItems, companySearch]);

    const companyFilteredItems = useMemo(() => {
        if (companyFilter === 'ALL') return searchFilteredItems;
        return searchFilteredItems.filter((it) => it.companyName === companyFilter);
    }, [searchFilteredItems, companyFilter]);

    // mineOnly 가 true + 직원 설정됨일 때만 슬롯 매칭으로 좁힌다.
    // 본인이 [작업완료] 누른 건은 기본 제외(per-worker independent) — 같은 슬롯 동료에겐 그대로 보임.
    // showCompleted ON 이면 완료건도 포함해서 보여주되, 썸네일에 완료 리본이 떠 시각적으로 구분된다.
    // 슬롯이 비어있는(워처 도입 이전) 지시서는 off 에서만 보여 누락 방지.
    const filtered = useMemo(() => {
        if (!mineOnly || !myWorker) return companyFilteredItems;
        return companyFilteredItems.filter((it) => {
            if (!matchesWorker(it.departmentSlots, myWorker)) return false;
            const done = Array.isArray(it.workerCompletions)
                && it.workerCompletions.some((c) => c.worker === myWorker);
            return showCompleted || !done;
        });
    }, [companyFilteredItems, mineOnly, myWorker, showCompleted]);

    // 토글 라벨용 카운트(본인 슬롯이 매칭된, 본인이 아직 안 끝낸 지시서 개수).
    const myCount = useMemo(() => {
        if (!myWorker) return 0;
        return companyFilteredItems.filter((it) => {
            const done = Array.isArray(it.workerCompletions)
                && it.workerCompletions.some((c) => c.worker === myWorker);
            return !done && matchesWorker(it.departmentSlots, myWorker);
        }).length;
    }, [companyFilteredItems, myWorker]);

    const groups = useMemo(() => {
        // 완료작업건 — 작업완료 처리일(deletedAt) 기준 일자 그룹, 최신 일자가 위.
        // 같은 날 안에서는 처리시각 늦은 게 위.
        if (sortMode === 'completed') {
            const map = new Map();
            filtered.forEach((it) => {
                const key = getCompletedGroupKey(it.deletedAt);
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(it);
            });
            map.forEach((list) => list.sort((a, b) => {
                const ta = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
                const tb = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
                return tb - ta;
            }));
            return Array.from(map.entries()).sort(([a], [b]) => {
                if (a === 'none') return 1;
                if (b === 'none') return -1;
                return b.localeCompare(a); // 최신 일자가 위.
            });
        }
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
    }, [filtered, sortMode]);

    // 뷰어로 진입 시 좌·우 스와이프 네비게이션에 쓸 형제 orderNumber 배열.
    // 현재 화면에 보이는 그룹 순서대로 평탄화 — 사용자가 보는 순서 그대로 다음/이전.
    const siblingOrderNumbers = useMemo(
        () => groups.flatMap(([, list]) => list.map((it) => it.orderNumber)),
        [groups],
    );

    // 갱신 시각을 상대 시간('방금 전' / 'n분 전' / 'n시간 n분 전')으로. 30초마다 재렌더해 라벨 갱신.
    const [, setNowTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setNowTick((t) => t + 1), 30000);
        return () => clearInterval(id);
    }, []);
    const formatSyncedAt = (d) => {
        if (!d) return '';
        const totalMin = Math.floor((Date.now() - d.getTime()) / 60000);
        if (totalMin <= 0) return '방금 전';
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        if (h > 0) return m > 0 ? `${h}시간 ${m}분 전` : `${h}시간 전`;
        return `${m}분 전`;
    };

    // 검색 펼침 여부 — 포커스 중이거나 검색어가 있으면 상단 바로 펼침(결과 보는 동안 유지),
    // 둘 다 아니면 우측 가장자리에 반원 탭으로 접힘.
    const searchOpen = searchFocused || companySearch.trim().length > 0;

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
                        <span className="ws-refresh-icon" aria-hidden="true">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M13.5 8a5.5 5.5 0 1 1-1.611-3.889" />
                                <path d="M13.5 2.5v3h-3" />
                            </svg>
                        </span>
                        <span>{refreshing ? '갱신 중…' : '새로고침'}</span>
                    </button>
                </div>

                <div className="ws-personal-row">
                    <label className="ws-mine-toggle">
                        <input
                            type="checkbox"
                            className="ws-mine-checkbox"
                            checked={mineOnly}
                            onChange={(e) => handleMineToggle(e.target.checked)}
                        />
                        <span className="ws-mine-text">
                            내 지시서만 보기
                            {myWorker && <span className="ws-mine-count"> · {myCount}건</span>}
                        </span>
                    </label>
                    <button type="button" className="ws-dept-chip-btn" onClick={openWorkerModal}>
                        <span className="ws-dept-chip-prefix">담당</span>
                        <span className="ws-dept-chip-text">{worker || '미설정'}</span>
                    </button>
                    {isPushSupported() && (
                        <button
                            type="button"
                            className="ws-dept-chip-btn"
                            onClick={() => { setPushMsg(''); setShowPushModal(true); }}
                        >
                            <span className="ws-dept-chip-prefix">알림</span>
                            <span className="ws-dept-chip-text">
                                {pushMode === 'all' ? '전체' : pushMode === 'mine' ? '내 지시서만' : '꺼짐'}
                            </span>
                        </button>
                    )}
                </div>

                {/* 내 지시서만 보기 체크 시에만 노출 — 본인 완료건도 함께 보기. 완료건은 리본이 떠 시각 구분. */}
                {mineOnly && myWorker && (
                    <div className="ws-personal-sub-row">
                        <label className="ws-mine-toggle ws-mine-sub">
                            <input
                                type="checkbox"
                                className="ws-mine-checkbox"
                                checked={showCompleted}
                                onChange={(e) => handleShowCompletedToggle(e.target.checked)}
                            />
                            <span className="ws-mine-text">작업완료건 보이기</span>
                        </label>
                    </div>
                )}

                <p className="ws-list-meta">
                    <span className="ws-list-meta-count">{filtered.length}건</span>
                    {lastSyncedAt && (
                        <>
                            <span className="ws-list-meta-sep">·</span>
                            <span className="ws-list-meta-sync">갱신 {formatSyncedAt(lastSyncedAt)}</span>
                        </>
                    )}
                </p>

                <div className="ws-sort-toggle" role="tablist" aria-label="목록 모드">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={sortMode === 'due'}
                        className={`ws-sort-tab ${sortMode === 'due' ? 'active' : ''}`}
                        onClick={() => setSortMode('due')}
                    >작업중</button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={sortMode === 'completed'}
                        className={`ws-sort-tab ${sortMode === 'completed' ? 'active' : ''}`}
                        onClick={() => setSortMode('completed')}
                    >완료작업건</button>
                </div>
            </header>

            {/* 거래처 검색 — 평소엔 우측 하단에 접힌 pill 로 걸쳐 있다가, 터치(포커스)하면
                목록 상단 sticky 바로 펼쳐진다. 검색어가 있으면 결과를 보는 동안 상단에 유지.
                열린 상태는 네이티브 sticky 라 스크롤 중 덜덜거림이 없다. */}
            <div className={`ws-search-dock ${searchOpen ? 'open' : ''}`}>
                <div className={`ws-search-row ${searchFocused ? 'focused' : ''}`}>
                    <span className="ws-search-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="7" cy="7" r="4.5" />
                            <path d="M10.5 10.5L13.5 13.5" />
                        </svg>
                    </span>
                    <input
                        type="search"
                        className="ws-search-input"
                        placeholder="거래처 검색"
                        value={companySearch}
                        onChange={(e) => setCompanySearch(e.target.value)}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                        enterKeyHint="search"
                        onKeyDown={(e) => {
                            // 모바일 키패드 '검색/확인' 누르면 키패드 닫기.
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                            }
                        }}
                    />
                    {companySearch && (
                        <button
                            type="button"
                            className="ws-search-clear"
                            onClick={() => setCompanySearch('')}
                            aria-label="검색어 지우기"
                        >×</button>
                    )}
                </div>
            </div>

            {loading && <div className="ws-empty">불러오는 중…</div>}
            {!loading && error && <div className="ws-empty error">{error}</div>}
            {!loading && !error && filtered.length === 0 && (
                <div className="ws-empty">
                    {sortMode === 'completed'
                        ? '표시할 완료 작업건이 없습니다.'
                        : '표시할 지시서가 없습니다.'}
                </div>
            )}

            {groups.map(([key, list]) => {
                const isCompletedMode = sortMode === 'completed';
                const isNoDate = key === 'none';
                const groupBadge = !isCompletedMode && !isNoDate ? getDueBadge(key) : null;
                return (
                    <section className="ws-group" key={key}>
                        <h2 className="ws-group-head">
                            {isCompletedMode ? (
                                <>
                                    <span className="ws-group-badge ws-group-badge--completed">완료</span>
                                    <span className="ws-group-date">{formatCompletedDateLabel(key)}</span>
                                </>
                            ) : isNoDate ? (
                                <span className="ws-group-date">납기 미정</span>
                            ) : (
                                <>
                                    {groupBadge && (
                                        <span className={`ws-group-badge ${groupBadge.kind}`}>{groupBadge.text}</span>
                                    )}
                                    <span className="ws-group-date">{formatDueDateLabel(key)}</span>
                                </>
                            )}
                            <span className="ws-group-count">{list.length}개</span>
                        </h2>
                        <div className="ws-grid">
                            {list.map((it) => {
                                const completedByMe = !!myWorker
                                    && Array.isArray(it.workerCompletions)
                                    && it.workerCompletions.some((c) => c.worker === myWorker);
                                return (
                                    <Link
                                        key={it.orderNumber}
                                        to={`/m/worksheets/${encodeURIComponent(it.orderNumber)}`}
                                        state={{ siblings: siblingOrderNumbers }}
                                        className="ws-grid-card"
                                        onPointerDown={() => {
                                            rememberWorksheetListView();
                                            preloadWorksheetViewerChunk(true);
                                        }}
                                        onClick={() => rememberWorksheetListView()}
                                    >
                                        <WorksheetThumbnail
                                            pdfUrl={it.worksheetPdfUrl}
                                            thumbnailUrl={it.worksheetThumbnailUrl}
                                            completed={isCompletedMode || completedByMe}
                                            evidenceCount={it.evidenceCount || 0}
                                        />
                                        <div className="ws-thumb-meta">
                                            <div className="ws-thumb-company">
                                                {it.companyName || '거래처 미상'}
                                            </div>
                                            {isCompletedMode && it.deletedAt && (
                                                <div className="ws-thumb-sub">
                                                    <span className="ws-thumb-completed-rel">
                                                        {formatCompletedRelative(it.deletedAt)} 완료
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                );
            })}

            {showWorkerModal && (
                <div
                    className="ws-dept-modal-backdrop"
                    onClick={() => {
                        // 직원 미설정 상태에서 백드롭 클릭으로 닫으면 mineOnly 자동 해제 — 무한 모달 방지.
                        setShowWorkerModal(false);
                        if (!worker && mineOnly) setMineOnly(false);
                    }}
                >
                    <div className="ws-dept-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>내 정보 설정</h2>
                        <p className="ws-dept-modal-desc">
                            이 휴대폰을 쓰는 본인 이름을 선택하세요. 워처 분배함에서 본인 슬롯에 꽂힌 지시서만 보이고,
                            [작업완료] 를 누르면 같은 슬롯 동료에게서도 사라집니다.
                        </p>
                        <div className="ws-dept-quick-chips">
                            {ALL_WORKERS.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={`ws-dept-quick-chip ${workerDraft === name ? 'active' : ''}`}
                                    onClick={() => setWorkerDraft(name)}
                                >{name}</button>
                            ))}
                        </div>
                        <div className="ws-dept-modal-actions">
                            <button
                                type="button"
                                className="ws-dept-modal-cancel"
                                onClick={() => {
                                    setShowWorkerModal(false);
                                    if (!worker && mineOnly) setMineOnly(false);
                                }}
                            >취소</button>
                            <button
                                type="button"
                                className="ws-dept-modal-confirm"
                                onClick={submitWorker}
                                disabled={!workerDraft.trim()}
                            >저장</button>
                        </div>
                    </div>
                </div>
            )}

            {showPushModal && (
                <div className="ws-dept-modal-backdrop" onClick={() => setShowPushModal(false)}>
                    <div className="ws-dept-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>지시서 변경 알림</h2>
                        <p className="ws-dept-modal-desc">
                            지시서가 재업로드로 변경(납기 변경 포함)되면 이 기기로 알림을 보냅니다.
                            처음 올라온 지시서(신규)는 알림이 오지 않습니다.
                        </p>
                        <div className="ws-push-options">
                            <label className="ws-mine-toggle">
                                <input
                                    type="radio"
                                    name="pushMode"
                                    checked={pushMode === 'all'}
                                    disabled={pushBusy}
                                    onChange={() => handlePushModeChange('all')}
                                />
                                <span className="ws-mine-text">전체 알림 받기</span>
                            </label>
                            <label className="ws-mine-toggle">
                                <input
                                    type="radio"
                                    name="pushMode"
                                    checked={pushMode === 'mine'}
                                    disabled={pushBusy || !myWorker}
                                    onChange={() => handlePushModeChange('mine')}
                                />
                                <span className="ws-mine-text">
                                    내 지시서만 알림받기
                                    {!myWorker && <span className="ws-mine-count"> (담당자 먼저 설정)</span>}
                                </span>
                            </label>
                            <label className="ws-mine-toggle">
                                <input
                                    type="radio"
                                    name="pushMode"
                                    checked={pushMode === 'off'}
                                    disabled={pushBusy}
                                    onChange={() => handlePushModeChange('off')}
                                />
                                <span className="ws-mine-text">알림 끄기</span>
                            </label>
                        </div>
                        {pushMsg && <p className="ws-dept-modal-desc">{pushMsg}</p>}
                        <div className="ws-dept-modal-actions">
                            <button
                                type="button"
                                className="ws-dept-modal-confirm"
                                onClick={() => setShowPushModal(false)}
                            >닫기</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
