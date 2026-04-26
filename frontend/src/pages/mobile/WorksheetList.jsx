import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './WorksheetList.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const DELIVERY_LABELS = {
    CARGO: '화물',
    QUICK: '퀵',
    DIRECT: '직접배송',
    PICKUP: '직접수령',
    LOCAL_CARGO: '용달',
};

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

function ddayBadge(days) {
    if (days === undefined || days === null) return null;
    if (days < 0) return { text: `${-days}일 지남`, kind: 'overdue' };
    if (days === 0) return { text: '당일', kind: 'today' };
    if (days === 1) return { text: 'D-1', kind: 'urgent' };
    if (days <= 3) return { text: `D-${days}`, kind: 'soon' };
    return { text: `D-${days}`, kind: 'normal' };
}

export default function WorksheetList() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [companyFilter, setCompanyFilter] = useState('ALL');
    const [lastSyncedAt, setLastSyncedAt] = useState(null);
    const aliveRef = useRef(true);

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

    useEffect(() => {
        aliveRef.current = true;
        fetchList();
        // 워처가 PDF 재업로드하면 즉시 보여야 하므로 30초마다 폴링
        const timer = setInterval(fetchList, 30000);
        // 백그라운드 → 포그라운드 복귀 시 즉시 재조회 (PWA 홈 아이콘 흐름 대응)
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

    const companyOptions = useMemo(() => {
        const set = new Set();
        items.forEach((it) => it.companyName && set.add(it.companyName));
        return Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'));
    }, [items]);

    const filtered = useMemo(() => {
        if (companyFilter === 'ALL') return items;
        return items.filter((it) => it.companyName === companyFilter);
    }, [items, companyFilter]);

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
                    <span className="ws-list-count">{filtered.length}건</span>
                </div>
                <div className="ws-list-sub-row">
                    <p className="ws-list-sub">
                        납기 임박 순
                        {lastSyncedAt && (
                            <span className="ws-list-sync"> · 갱신 {formatSyncedAt(lastSyncedAt)}</span>
                        )}
                    </p>
                    <button
                        type="button"
                        className={`ws-refresh-btn ${refreshing ? 'spinning' : ''}`}
                        onClick={() => fetchList({ manual: true })}
                        disabled={refreshing}
                        aria-label="새로고침"
                    >
                        <span className="ws-refresh-icon" aria-hidden="true">⟳</span>
                        <span>{refreshing ? '갱신 중…' : '새로고침'}</span>
                    </button>
                </div>
            </header>

            {companyOptions.length > 0 && (
                <div className="ws-filter-bar">
                    <button
                        type="button"
                        className={`ws-chip ${companyFilter === 'ALL' ? 'active' : ''}`}
                        onClick={() => setCompanyFilter('ALL')}
                    >
                        전체 ({items.length})
                    </button>
                    {companyOptions.map((name) => {
                        const count = items.filter((it) => it.companyName === name).length;
                        return (
                            <button
                                key={name}
                                type="button"
                                className={`ws-chip ${companyFilter === name ? 'active' : ''}`}
                                onClick={() => setCompanyFilter(name)}
                            >
                                {name} ({count})
                            </button>
                        );
                    })}
                </div>
            )}

            {loading && <div className="ws-empty">불러오는 중…</div>}
            {!loading && error && <div className="ws-empty error">{error}</div>}
            {!loading && !error && filtered.length === 0 && (
                <div className="ws-empty">표시할 지시서가 없습니다.</div>
            )}

            {groups.map(([key, list]) => {
                const headerLabel = key === 'none' ? '납기 미정' : formatDateLabel(key);
                return (
                    <section className="ws-group" key={key}>
                        <h2 className="ws-group-head">{headerLabel}</h2>
                        <div className="ws-cards">
                            {list.map((it) => {
                                const dday = ddayBadge(it.daysUntilDue);
                                return (
                                    <Link
                                        key={it.orderNumber}
                                        to={`/m/worksheets/${encodeURIComponent(it.orderNumber)}`}
                                        className="ws-card"
                                    >
                                        <div className="ws-card-top">
                                            <span className="ws-card-company">{it.companyName || '거래처 미상'}</span>
                                            {dday && <span className={`ws-card-dday ${dday.kind}`}>{dday.text}</span>}
                                        </div>
                                        <div className="ws-card-title">{it.title || '제목 없음'}</div>
                                        <div className="ws-card-meta">
                                            <span className="ws-card-order">{it.orderNumber}</span>
                                            {it.dueTime && <span>· {it.dueTime}</span>}
                                            {it.deliveryMethod && (
                                                <span>· {DELIVERY_LABELS[it.deliveryMethod] || it.deliveryMethod}</span>
                                            )}
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
