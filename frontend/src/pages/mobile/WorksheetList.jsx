import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import { ALL_WORKERS, matchesWorker } from '../../data/workers.js';
import { getStoredWorker, setStoredWorker } from '../../data/workerStorage.js';
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
    const [lastSyncedAt, setLastSyncedAt] = useState(() => worksheetListSnapshot.syncedAt);
    // 다중 선택 모드 — 카드 탭으로 토글, 하단 sticky 바의 [작업완료] 로 N건 한꺼번에 처리.
    // 각각 들어가서 처리하는 흐름은 그대로 유지(선택 모드 OFF 일 때 Link 가 동작).
    const [selectMode, setSelectMode] = useState(false);
    const [selectedNumbers, setSelectedNumbers] = useState(() => new Set());
    const [bulkCompleting, setBulkCompleting] = useState(false);
    const [bulkError, setBulkError] = useState('');
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

    // 선택 모드 토글 — ON 진입 시 직원 미설정이면 모달부터 띄움(작업완료 시점에 어차피 필요).
    const toggleSelectMode = () => {
        if (!selectMode && !worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        setSelectMode((prev) => {
            const next = !prev;
            if (!next) setSelectedNumbers(new Set());
            return next;
        });
        setBulkError('');
    };

    const toggleSelected = (orderNumber) => {
        setSelectedNumbers((prev) => {
            const next = new Set(prev);
            if (next.has(orderNumber)) next.delete(orderNumber);
            else next.add(orderNumber);
            return next;
        });
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

    // 거래처 옵션 — 날짜+검색에 걸린 항목만 모아서 카운트. 필터를 좁히면
    // 해당 거래처 건수도 자연스럽게 줄거나(0건이면 옵션이 사라짐) 그대로 유지.
    const companyOptions = useMemo(() => {
        const counts = new Map();
        searchFilteredItems.forEach((it) => {
            if (it.companyName) counts.set(it.companyName, (counts.get(it.companyName) || 0) + 1);
        });
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }, [searchFilteredItems]);

    // 선택해둔 거래처가 날짜/검색 필터 변경으로 옵션에서 사라지면 자동으로 '전체' 로 리셋.
    useEffect(() => {
        if (companyFilter === 'ALL') return;
        if (!companyOptions.some((c) => c.name === companyFilter)) {
            setCompanyFilter('ALL');
        }
    }, [companyFilter, companyOptions]);

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

    // 선택 모드에서 사라진(다른 디바이스에서 처리) 항목은 자동으로 선택 해제.
    useEffect(() => {
        if (!selectMode) return;
        const visibleSet = new Set(filtered.map((it) => it.orderNumber));
        setSelectedNumbers((prev) => {
            let changed = false;
            const next = new Set();
            prev.forEach((n) => {
                if (visibleSet.has(n)) next.add(n);
                else changed = true;
            });
            return changed ? next : prev;
        });
    }, [filtered, selectMode]);

    const visibleAllSelected = filtered.length > 0
        && filtered.every((it) => selectedNumbers.has(it.orderNumber));

    const toggleAllVisible = () => {
        if (visibleAllSelected) {
            setSelectedNumbers(new Set());
        } else {
            setSelectedNumbers(new Set(filtered.map((it) => it.orderNumber)));
        }
    };

    // 일괄 작업완료 — 선택된 건들에 worker-complete 병렬 호출. 일부 실패해도 성공한 건은 그대로 반영.
    // 멱등(이미 완료된 건은 200) — 다른 직원이 같은 슬롯 동료로 먼저 완료한 경우에도 안전.
    const handleBulkComplete = async () => {
        if (!selectedNumbers.size || bulkCompleting) return;
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        if (!window.confirm(`선택한 ${selectedNumbers.size}건을 작업완료 처리하시겠습니까?`)) return;
        setBulkCompleting(true);
        setBulkError('');
        const targets = Array.from(selectedNumbers);
        try {
            const results = await Promise.allSettled(
                targets.map((orderNumber) =>
                    fetch(
                        `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}/worker-complete`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ worker }),
                        },
                    ).then((r) => {
                        if (!r.ok) throw new Error(`${orderNumber}`);
                        return orderNumber;
                    }),
                ),
            );
            const failed = results.filter((r) => r.status === 'rejected').length;
            if (failed > 0) {
                setBulkError(`${failed}건 처리 실패 — 잠시 후 다시 시도해 주세요.`);
            }
            setSelectedNumbers(new Set());
            setSelectMode(false);
            await fetchList({ manual: true });
        } catch (err) {
            setBulkError(err.message || '일괄 처리 중 오류');
        } finally {
            setBulkCompleting(false);
        }
    };

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
                        <span className="ws-refresh-icon" aria-hidden="true">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M13.5 8a5.5 5.5 0 1 1-1.611-3.889" />
                                <path d="M13.5 2.5v3h-3" />
                            </svg>
                        </span>
                        <span>{refreshing ? '갱신 중…' : '새로고침'}</span>
                    </button>
                </div>
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
                        onClick={() => {
                            setSortMode('due');
                            // 다른 모드의 선택 모드/선택 항목 잔존 방지.
                            if (selectMode) setSelectMode(false);
                            setSelectedNumbers(new Set());
                            setBulkError('');
                        }}
                    >납기 임박순</button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={sortMode === 'completed'}
                        className={`ws-sort-tab ${sortMode === 'completed' ? 'active' : ''}`}
                        onClick={() => {
                            setSortMode('completed');
                            // 완료작업건 모드는 일괄 작업완료가 의미 없음 — 선택 모드 해제.
                            if (selectMode) setSelectMode(false);
                            setSelectedNumbers(new Set());
                            setBulkError('');
                        }}
                    >완료작업건</button>
                </div>

                <form className="ws-filter-form" onSubmit={(e) => e.preventDefault()}>
                    {/* 완료작업건 모드는 납기(미래) 필터 의미가 없어 거래처 셀렉트를 1단으로 펼침. */}
                    {sortMode !== 'completed' && (
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
                    )}
                    <label
                        className="ws-filter-field"
                        style={sortMode === 'completed' ? { gridColumn: '1 / -1' } : undefined}
                    >
                        <span className="ws-filter-label">거래처</span>
                        <select
                            className="ws-filter-select"
                            value={companyFilter}
                            onChange={(e) => setCompanyFilter(e.target.value)}
                        >
                            <option value="ALL">전체 ({searchFilteredItems.length})</option>
                            {companyOptions.map(({ name, count }) => (
                                <option key={name} value={name}>{name} ({count})</option>
                            ))}
                        </select>
                    </label>
                </form>

                <div className="ws-search-row">
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

                {/* 다중 선택 모드 — 카드 탭으로 N건 선택해 한 번에 작업완료. 선택 모드 OFF 시 카드는
                    그대로 Link 동작(각각 들어가서 처리). 발주관리 selectMode 와 같은 패턴.
                    완료작업건 모드는 이미 마감된 건들이라 일괄 작업완료 의미 없음 — 토글 숨김. */}
                {sortMode !== 'completed' && (
                    <div className="ws-action-row">
                        <button
                            type="button"
                            className={`ws-select-toggle ${selectMode ? 'active' : ''}`}
                            onClick={toggleSelectMode}
                            disabled={bulkCompleting}
                        >
                            {selectMode
                                ? `선택 모드 끄기${selectedNumbers.size > 0 ? ` · ${selectedNumbers.size}건` : ''}`
                                : '여러 개 선택해 일괄 완료'}
                        </button>
                    </div>
                )}
            </header>

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
                                const isSelected = selectedNumbers.has(it.orderNumber);
                                const completedByMe = !!myWorker
                                    && Array.isArray(it.workerCompletions)
                                    && it.workerCompletions.some((c) => c.worker === myWorker);
                                const cardClass = `ws-grid-card${selectMode ? ' select-mode' : ''}${isSelected ? ' selected' : ''}`;
                                const cardContent = (
                                    <>
                                        <WorksheetThumbnail
                                            pdfUrl={it.worksheetPdfUrl}
                                            thumbnailUrl={it.worksheetThumbnailUrl}
                                            completed={isCompletedMode || completedByMe}
                                            evidenceCount={it.evidenceCount || 0}
                                        />
                                        {selectMode && (
                                            <span className={`ws-grid-check ${isSelected ? 'on' : ''}`} aria-hidden="true">
                                                {isSelected && (
                                                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M3.5 8.5l3 3 6-7" />
                                                    </svg>
                                                )}
                                            </span>
                                        )}
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
                                    </>
                                );
                                if (selectMode) {
                                    return (
                                        <button
                                            type="button"
                                            key={it.orderNumber}
                                            className={cardClass}
                                            onClick={() => toggleSelected(it.orderNumber)}
                                            aria-pressed={isSelected}
                                        >
                                            {cardContent}
                                        </button>
                                    );
                                }
                                return (
                                    <Link
                                        key={it.orderNumber}
                                        to={`/m/worksheets/${encodeURIComponent(it.orderNumber)}`}
                                        state={{ siblings: siblingOrderNumbers }}
                                        className={cardClass}
                                        onPointerDown={() => {
                                            rememberWorksheetListView();
                                            preloadWorksheetViewerChunk(true);
                                        }}
                                        onClick={() => rememberWorksheetListView()}
                                    >
                                        {cardContent}
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                );
            })}

            {selectMode && (
                <div className="ws-select-bar" role="region" aria-label="선택 모드">
                    {bulkError && <div className="ws-select-bar-error">{bulkError}</div>}
                    <div className="ws-select-bar-row">
                        <span className="ws-select-bar-count">
                            <strong>{selectedNumbers.size}</strong>건 / {filtered.length}
                        </span>
                        <button
                            type="button"
                            className="ws-select-bar-ghost"
                            onClick={toggleAllVisible}
                            disabled={filtered.length === 0 || bulkCompleting}
                        >
                            {visibleAllSelected ? '해제' : '전체'}
                        </button>
                        <button
                            type="button"
                            className="ws-select-bar-complete"
                            onClick={handleBulkComplete}
                            disabled={selectedNumbers.size === 0 || bulkCompleting}
                        >
                            {bulkCompleting ? '처리 중…' : `${selectedNumbers.size > 0 ? `${selectedNumbers.size}건 ` : ''}작업완료`}
                        </button>
                    </div>
                </div>
            )}

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
        </div>
    );
}
