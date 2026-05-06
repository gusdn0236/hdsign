import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import { ALL_WORKERS, matchesWorker } from '../../data/workers.js';
import './WorksheetList.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

// 모바일 뷰어 직원 식별 — WorksheetViewer / EvidenceCapture 와 같은 키 공유.
// 휴대폰 단말 단위로 "이 폰은 누구의 폰" 으로 한 번 설정해두면 자동 적용.
// 워처 분배함은 부서 기준 그대로 유지하고, 모바일 필터만 직원 기준으로 매칭한다(workers.js 매핑).
const WORKER_KEY = 'hdsign_uploader_worker';

// "내 지시서만 보기" 를 사용자가 명시적으로 푼 직원 이름. 담당자가 설정되어 있으면 default 는 ON 이지만,
// 한 번 풀고 나면 다시 켜기 전까지는 OFF 유지(workerName 저장으로 직원이 바뀌면 다시 default ON).
const MINE_OFF_KEY = 'hdsign_mine_off_worker';

function getStoredWorker() {
    try {
        const v = localStorage.getItem(WORKER_KEY);
        return v ? v.trim() : '';
    } catch {
        return '';
    }
}
function setStoredWorker(value) {
    try {
        if (value) localStorage.setItem(WORKER_KEY, value);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
}
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

// 그룹 헤더용: '5월 6일 (수)' 만 — 오늘/내일/지남 같은 상태는 배지로 별도 표시.
function formatDueDateLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${md} (${dow})`;
}

// 카드 보조 라인용 짧은 형식: '5/7'.
function formatShortDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    return `${d.getMonth() + 1}/${d.getDate()}`;
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

// '최근 업로드순' 카드 보조 라인용 상대시간. 7일 넘으면 'M/D' 로 폴백.
function formatRelativeUpload(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60) return '방금';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

function getGroupKey(dateStr) {
    if (!dateStr) return 'none';
    return dateStr;
}

export default function WorksheetList() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [dateFilter, setDateFilter] = useState('all'); // 'today' | '3days' | 'all'
    const [companyFilter, setCompanyFilter] = useState('ALL');
    const [companySearch, setCompanySearch] = useState('');
    // 'due' = 납기 임박순(날짜 그룹), 'uploaded' = 최근 업로드순(평탄 리스트, 방금 올린 게 최상단).
    const [sortMode, setSortMode] = useState('due');
    // 체크 시 본인 슬롯에 매핑된 지시서만 노출 + 본인이 [작업완료] 누른 건 자동 제외(per-worker).
    // 담당자가 있으면 default = ON. 사용자가 직접 풀면 그 직원 이름이 MINE_OFF_KEY 에 저장되어
    // 다음 진입에도 OFF 유지. 직원이 바뀌면 자동으로 default ON 복귀(이전 OFF 키와 다른 이름이라).
    const [worker, setWorker] = useState(() => getStoredWorker());
    const [mineOnly, setMineOnly] = useState(() => {
        const w = getStoredWorker();
        if (!w) return false;
        return getStoredMineOffWorker() !== w;
    });
    const [showWorkerModal, setShowWorkerModal] = useState(false);
    const [workerDraft, setWorkerDraft] = useState('');
    const [lastSyncedAt, setLastSyncedAt] = useState(null);
    // 다중 선택 모드 — 카드 탭으로 토글, 하단 sticky 바의 [작업완료] 로 N건 한꺼번에 처리.
    // 각각 들어가서 처리하는 흐름은 그대로 유지(선택 모드 OFF 일 때 Link 가 동작).
    const [selectMode, setSelectMode] = useState(false);
    const [selectedNumbers, setSelectedNumbers] = useState(() => new Set());
    const [bulkCompleting, setBulkCompleting] = useState(false);
    const [bulkError, setBulkError] = useState('');
    const aliveRef = useRef(true);

    const myWorker = worker.trim();

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
    // 본인이 [작업완료] 누른 건은 본인 리스트에서만 제외(per-worker independent) — 같은 슬롯
    // 동료에게는 그대로 보임. 슬롯이 비어있는(워처 도입 이전) 지시서는 off 에서만 보여 누락 방지.
    const filtered = useMemo(() => {
        if (!mineOnly || !myWorker) return companyFilteredItems;
        return companyFilteredItems.filter((it) => {
            const done = Array.isArray(it.workerCompletions)
                && it.workerCompletions.some((c) => c.worker === myWorker);
            return !done && matchesWorker(it.departmentSlots, myWorker);
        });
    }, [companyFilteredItems, mineOnly, myWorker]);

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
        // 최근 업로드순 — 그룹 분리 없이 평탄 리스트. 방금 올린 게 최상단.
        // worksheetUpdatedAt 이 비어있는(아주 옛날) 항목은 0 으로 가라앉힘.
        if (sortMode === 'uploaded') {
            const sorted = [...filtered].sort((a, b) => {
                const ta = a.worksheetUpdatedAt ? new Date(a.worksheetUpdatedAt).getTime() : 0;
                const tb = b.worksheetUpdatedAt ? new Date(b.worksheetUpdatedAt).getTime() : 0;
                return tb - ta;
            });
            return [['__uploaded__', sorted]];
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

                <div className="ws-sort-toggle" role="tablist" aria-label="정렬 방식">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={sortMode === 'due'}
                        className={`ws-sort-tab ${sortMode === 'due' ? 'active' : ''}`}
                        onClick={() => setSortMode('due')}
                    >납기 임박순</button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={sortMode === 'uploaded'}
                        className={`ws-sort-tab ${sortMode === 'uploaded' ? 'active' : ''}`}
                        onClick={() => setSortMode('uploaded')}
                    >최근 업로드순</button>
                </div>

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

                {/* 다중 선택 모드 — 카드 탭으로 N건 선택해 한 번에 작업완료. 선택 모드 OFF 시 카드는
                    그대로 Link 동작(각각 들어가서 처리). 발주관리 selectMode 와 같은 패턴. */}
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
            </header>

            {loading && <div className="ws-empty">불러오는 중…</div>}
            {!loading && error && <div className="ws-empty error">{error}</div>}
            {!loading && !error && filtered.length === 0 && (
                <div className="ws-empty">표시할 지시서가 없습니다.</div>
            )}

            {groups.map(([key, list]) => {
                const isUploaded = key === '__uploaded__';
                const isNoDate = key === 'none';
                const groupBadge = !isUploaded && !isNoDate ? getDueBadge(key) : null;
                return (
                    <section className="ws-group" key={key}>
                        <h2 className="ws-group-head">
                            {isUploaded ? (
                                <span className="ws-group-date">최근 업로드</span>
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
                                const cardBadge = isUploaded ? getDueBadge(it.dueDate) : null;
                                const isSelected = selectedNumbers.has(it.orderNumber);
                                const cardClass = `ws-grid-card${selectMode ? ' select-mode' : ''}${isSelected ? ' selected' : ''}`;
                                const cardContent = (
                                    <>
                                        <WorksheetThumbnail
                                            pdfUrl={it.worksheetPdfUrl}
                                            thumbnailUrl={it.worksheetThumbnailUrl}
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
                                            {isUploaded && (
                                                <div className="ws-thumb-sub">
                                                    {cardBadge ? (
                                                        <span className={`ws-thumb-badge ${cardBadge.kind}`}>{cardBadge.text}</span>
                                                    ) : it.dueDate ? (
                                                        <span className="ws-thumb-date">{formatShortDate(it.dueDate)}</span>
                                                    ) : null}
                                                    {it.worksheetUpdatedAt && (
                                                        <span className="ws-thumb-uploaded">{formatRelativeUpload(it.worksheetUpdatedAt)}</span>
                                                    )}
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
                                        className={cardClass}
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
