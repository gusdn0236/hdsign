import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorksheetThumbnail from '../../components/common/WorksheetThumbnail.jsx';
import WorksheetLightbox from '../../components/common/WorksheetLightbox.jsx';
import KakaoShareButton from '../../components/common/KakaoShareButton.jsx';
import { safeFileName } from '../../utils/shareImage.js';
import { ALL_WORKERS, matchesWorker } from '../../data/workers.js';
import { getStoredWorker as readWorker, setStoredWorker as writeWorker } from '../../data/workerStorage.js';
import './FieldViewer.css';

// 현장 PC 사이드바 뷰어 — Chrome --app=https://.../field 로 띄워 화면 한쪽에 박아두는 용도.
// 모바일 뷰어와 같은 endpoint(/api/public/worksheets, /worker-complete) 를 그대로 쓰고,
// [FS에서 열기] 만 로컬 에이전트(127.0.0.1) 에게 위임해 거래처 네트워크 폴더에서
// .fs 파일을 찾아 FlexiSIGN 으로 실행한다.

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const AGENT_URL = import.meta.env.VITE_HDSIGN_AGENT_URL || 'http://127.0.0.1:17345';
// "내 지시서만 보기" 체크 상태 — 켜면 본인 부서 슬롯에 잡힌 지시서만 보임(미설정 시 기본 켜짐).
const MYONLY_KEY = 'hdsign_field_myonly';
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
    const [designating, setDesignating] = useState(null); // orderNumber 진행중 ([파일지정])
    const [completing, setCompleting] = useState(null);   // orderNumber 진행중
    const [toast, setToast] = useState(null);             // {kind, text}
    const [confirmAction, setConfirmAction] = useState(null); // {message, confirmText, onConfirm}
    const [selectedIndex, setSelectedIndex] = useState(-1);   // 키보드 선택 카드(검색→↓ 로 진입)
    // 작업지시서 확대 보기 — 돋보기로 연 지시서의 orderNumber(목록 폴링에도 안전).
    const [lightboxOrder, setLightboxOrder] = useState(null);
    // '여시겠습니까?' 확인창 — { item }. openChoice 로 [FS에서 열기]/[폴더열기] 중 선택.
    const [openConfirm, setOpenConfirm] = useState(null);
    const [openChoice, setOpenChoice] = useState('fs'); // 'fs'=FS에서 열기(기본) | 'folder'=폴더열기
    const aliveRef = useRef(true);
    const cardsRef = useRef(null);
    const searchInputRef = useRef(null);
    // '여시겠습니까?' 확인창 arm 플래그 — 확인창을 띄운 그 키를 한 번 뗀 뒤(keyup)에만
    // Enter 확정을 허용한다. askOpen 에서 false 로 리셋 → 항상 켜진 keyup 리스너가 true 로.
    const confirmArmRef = useRef(false);
    // 완료/취소 낙관적 갱신이 일어날 때마다 +1. 백그라운드 폴링 fetch 가 시작 시점의
    // 값과 응답 시점의 값이 다르면(=폴링이 도는 사이 사용자가 완료/취소를 누름) 그 응답은
    // 옛 데이터라 버린다 — 방금 누른 [완료]가 폴링 응답에 덮여 되돌아가는 race 방지.
    const mutationGenRef = useRef(0);

    const fetchList = useCallback(async ({ manual = false, silent = false } = {}) => {
        if (manual) setRefreshing(true);
        const genAtStart = mutationGenRef.current;
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
            // 백그라운드 폴링이 도는 사이 사용자가 완료/취소를 눌렀으면, 그 낙관적 갱신을
            // 폴링이 가져온 옛 데이터로 덮어쓰지 않도록 이번 응답은 버린다(다음 폴링이 반영).
            if (silent && mutationGenRef.current !== genAtStart) return;
            setItems(Array.isArray(activeData) ? activeData : []);
            setCompletedItems(Array.isArray(doneData) ? doneData : []);
            setError('');
        } catch (err) {
            if (!aliveRef.current) return;
            // 백그라운드 폴링 실패는 화면에 노출하지 않는다 — 일시적 네트워크 끊김에
            // 에러 배너가 깜빡이는 잡음 방지. 마지막 정상 목록을 그대로 두고 다음 폴링이 복구.
            if (!silent) setError(err.message || '오류가 발생했습니다.');
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
        // 모달이 떠 있을 때만 양보(모달이 focus 주인). 직전에 거래처를 열어 카드가 선택돼 남아 있어도
        // 작업표시줄로 다시 켜면 선택을 풀고 검색창에 포커스한다 — 언제 켜도 바로 검색할 수 있도록.
        const focusSearchSoon = () => {
            // 약간 지연 — 브라우저가 창 활성화 직후 처리하는 native focus 와 충돌하지 않도록.
            window.setTimeout(() => {
                const el = searchInputRef.current;
                if (!el) return;
                // 확인/담당자 모달이 떠 있으면 그쪽이 focus 주인 — 가로채지 않는다.
                if (document.querySelector('.fv-modal-bg')) return;
                // 직전에 키보드/열기로 골라둔 카드 선택은 해제 — 검색창부터 새로 시작(↓ 가 0번부터,
                // 엉뚱한 카드가 강조된 채 남지 않음). 이게 없으면 .fv-card.selected 가 남아
                // 다음번 작업표시줄 클릭 때 포커스가 안 잡혔다.
                setSelectedIndex(-1);
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
        // 현장 PC 는 항상 켜진 데스크톱(데이터 요금 무관) — 모바일 지시서에서 누른 [완료]가
        // 현장 화면에도 자동으로 반영되도록 주기적으로 목록을 다시 가져온다. 모바일 목록과 달리
        // 폴링을 켜는 이유. silent: 스피너·에러배너 없이 조용히 갱신. 창이 최소화돼 안 보일
        // 땐 건너뛰고, 다시 보이면 onVisible 이 즉시 1회 당겨오므로 공백 없이 이어진다.
        const pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') fetchList({ silent: true });
        }, 20000);
        // 초기 마운트에도 1회 포커스 — Chrome --app 으로 띄우자마자 키보드 입력 가능.
        focusSearchSoon();
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onWindowFocus);
            window.clearInterval(pollTimer);
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

    // 선택된 카드가 sticky 헤더에 가려지지 않게 스크롤. scrollIntoView 는 sticky 헤더 높이를
    // 모르기 때문에 카드가 헤더 뒤에 숨어도 '보인다'고 판단하거나, focus() 가 일으킨 스크롤과
    // 겹쳐 첫 카드가 헤더 밑으로 들어가던 문제 → 헤더 높이만큼 빼고 직접 스크롤한다.
    // 이미 다 보이는 위치면 아예 안 움직임(첫 카드 선택 시 불필요한 한 칸 밀림 제거).
    useEffect(() => {
        if (selectedIndex < 0) return;
        const el = cardsRef.current?.querySelector(`[data-card-index="${selectedIndex}"]`);
        if (!el) return;
        const header = document.querySelector('.fv-header');
        const headerH = header ? header.getBoundingClientRect().height : 0;
        const rect = el.getBoundingClientRect();
        const margin = 8;
        if (rect.top < headerH + margin) {
            // 카드 위쪽이 헤더에 가려짐 → 헤더 바로 아래로 내려오게.
            window.scrollBy({ top: rect.top - headerH - margin, behavior: 'smooth' });
        } else if (rect.bottom > window.innerHeight - margin) {
            // 카드 아래쪽이 화면 밖으로 벗어남 → 위로 끌어올림.
            window.scrollBy({ top: rect.bottom - window.innerHeight + margin, behavior: 'smooth' });
        }
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

    // [파일지정] — 사용자가 파일선택창에서 이 지시서의 .fs 를 직접 고른다. 에이전트가 고른
    // 파일에 UID 도장(ADS)을 찍고 서버(originalFsUid/경로)에 저장 → 이후 [FS에서 열기]가 정확히
    // 그 파일을 연다(이름 바꿔도 따라감). UID 도입 전 옛 지시서/매칭이 틀린 건을 재인쇄 없이 고정.
    const handleDesignate = useCallback(async (it) => {
        if (!(it.networkFolderName || it.companyName)) {
            showToast('warn', '거래처 정보가 비어 있어 폴더를 찾을 수 없는 지시서입니다.', 5000);
            return;
        }
        setDesignating(it.orderNumber);
        try {
            const res = await fetch(`${AGENT_URL}/designate`, {
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
            if (body.designated) {
                showToast('success', body.message || '파일을 지정했습니다.', 5000);
            } else {
                showToast('warn', body.message || '파일을 지정하지 못했습니다.', 5000);
            }
        } catch {
            showToast(
                'error',
                '에이전트 연결 실패 — 트레이의 HD사인 작업뷰어 프로그램이 켜져있는지 확인하세요.',
                6000,
            );
        } finally {
            setDesignating(null);
        }
    }, [showToast]);

    // 키보드로 지시서 열기 — Enter 로 '여시겠습니까?' 확인창을 띄운다. 확인창에서 ←/→ 로
    // [FS에서 열기]/[폴더열기] 를 고르고 Enter 로 실행. preferChoice 로 처음 선택을 정한다
    // (카드 ↓ 선택·라이트박스 = FS, 카드 [폴더열기] 버튼 키보드 활성화 = 폴더). 카드 키보드
    // 조작·라이트박스·카드 버튼(키보드 활성화)이 모두 같은 함수를 쓴다 — 키보드로 열 땐 늘
    // 확인창을 거치고, 마우스 클릭만 곧바로 실행. 거래처 정보가 없으면 어느 쪽도 폴더를 못
    // 찾으므로 바로 handleOpenFs 가 안내 토스트를 띄운다.
    const askOpen = useCallback((it, preferChoice = 'fs') => {
        if (!it) return;
        const fsReady = !!(it.networkFolderName || it.companyName);
        if (!fsReady) {
            // 거래처 정보 없음 → 폴더 자체를 못 찾음. 확대 보기를 닫아 안내 토스트가 보이게 한다.
            setLightboxOrder(null);
            handleOpenFs(it);
            return;
        }
        setOpenChoice(preferChoice === 'folder' ? 'folder' : 'fs');
        // 확인창을 띄운 그 Enter 로는 확정 못 하게 — 키를 한 번 떼야(keyup) arm 된다.
        confirmArmRef.current = false;
        setOpenConfirm({ item: it });
    }, [handleOpenFs]);

    // 확인창에서 고른 동작 실행 — 기본 Enter=FS, →+Enter=폴더. 확대 보기도 함께 닫아
    // 결과 토스트가 가려지지 않게 한다.
    const runOpenChoice = useCallback((choice) => {
        const it = openConfirm?.item;
        setOpenConfirm(null);
        setLightboxOrder(null);
        if (!it) return;
        if (choice === 'folder') handleOpenFolder(it);
        else handleOpenFs(it);
    }, [openConfirm, handleOpenFolder, handleOpenFs]);

    const closeLightbox = useCallback(() => setLightboxOrder(null), []);

    // 확인창 arm — 마운트 때부터 항상 듣는 keyup 리스너. 확인창을 띄운 키를 떼는 순간을
    // 절대 놓치지 않으려고 여기서 잡는다(아래 확인창 이펙트의 리스너는 저사양 현장 PC 에서
    // 늦게 붙어, 확인창을 연 그 Enter 의 keyup 을 지나치곤 했다 → 그래서 Enter 를 두 번
    // 눌러야 열렸다). askOpen 이 confirmArmRef 를 false 로 리셋 → 키를 한 번 떼면 true.
    useEffect(() => {
        const onUp = () => { confirmArmRef.current = true; };
        window.addEventListener('keyup', onUp);
        return () => window.removeEventListener('keyup', onUp);
    }, []);

    // '여시겠습니까?' 확인창 키 처리 — ←/→ 로 선택, Enter 실행, Esc 취소.
    // 라이트박스가 떠 있어도 이 확인창이 우선이며, 라이트박스 키 핸들러는 confirmActive 로 양보한다.
    // Enter 확정 조건 = 새로 누른 Enter(!e.repeat) + confirmArmRef(확인창을 연 키를 한 번 뗐음).
    // 확인창을 띄운 그 Enter keydown 이 갓 붙은 이 리스너에 그대로 잡히거나 누른 채 오토리피트가
    // 돌아도 arm 전이라 확정되지 않는다 → 확인창이 떠 있을 땐 Enter 한 번이면 열린다.
    useEffect(() => {
        if (!openConfirm) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); setOpenConfirm(null); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); setOpenChoice('fs'); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); setOpenChoice('folder'); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (!e.repeat && confirmArmRef.current) runOpenChoice(openChoice);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [openConfirm, openChoice, runOpenChoice]);

    // 확대 보기를 열면 — 현장 사이드바 창은 폭 420px 라 지시서가 작게 보인다. 그동안만
    // 브라우저 창을 모니터 중앙의 큰 크기로 키우고, 닫으면 원래 도킹 위치·크기로 되돌린다.
    // (라이트박스·PdfViewer 는 vw/vh + resize 리스너라 창 크기에 맞춰 자동으로 커진다.)
    // 의존성을 lightboxOpen(불리언)으로 둬 ←/→ 로 지시서를 넘길 땐 창이 안 흔들리게 한다.
    const lightboxOpen = lightboxOrder != null;
    useEffect(() => {
        if (!lightboxOpen) return undefined;
        const prev = {
            x: window.screenX, y: window.screenY,
            w: window.outerWidth, h: window.outerHeight,
        };
        try {
            const scr = window.screen;
            const aw = scr.availWidth;
            const ah = scr.availHeight;
            const al = scr.availLeft || 0;
            const at = scr.availTop || 0;
            const w = Math.min(1280, Math.round(aw * 0.94));
            const h = Math.round(ah * 0.96);
            window.resizeTo(w, h);
            window.moveTo(al + Math.round((aw - w) / 2), at + Math.round((ah - h) / 2));
        } catch { /* resizeTo/moveTo 가 막힌 환경 — 현재 창 크기 그대로 표시 */ }
        return () => {
            try {
                window.resizeTo(prev.w, prev.h);
                window.moveTo(prev.x, prev.y);
            } catch { /* ignore */ }
        };
    }, [lightboxOpen]);

    // fv-cards 영역(검색창에서 ↓ 로 진입)에서의 키 처리.
    const handleCardsKeyDown = useCallback((e) => {
        // 라이트박스나 확인창이 떠 있으면 그쪽 키 핸들러가 처리 — 카드 영역은 양보(중복 방지).
        if (lightboxOrder || openConfirm) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((i) => Math.min((i < 0 ? -1 : i) + 1, sorted.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((i) => {
                if (i <= 0) { searchInputRef.current?.focus({ preventScroll: true }); return -1; }
                return i - 1;
            });
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0 && selectedIndex < sorted.length) {
                e.preventDefault();
                askOpen(sorted[selectedIndex]);
            }
        }
    }, [sorted, selectedIndex, askOpen, lightboxOrder, openConfirm]);

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
                    // gen 을 올려, 진행 중이던 폴링 응답이 이 갱신을 덮어쓰지 못하게 한다.
                    mutationGenRef.current += 1;
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
                    // gen 을 올려, 진행 중이던 폴링 응답이 이 갱신을 덮어쓰지 못하게 한다.
                    mutationGenRef.current += 1;
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
                                    // 이미 키보드로 골라둔 카드가 있으면 그 자리에서 이어서 —
                                    // 0번(맨 위)으로 되돌리지 않는다.
                                    setSelectedIndex((i) => (i >= 0 && i < sorted.length ? i : 0));
                                    // preventScroll — focus() 기본 동작이 fv-cards 컨테이너를
                                    // 보이게 하려 페이지를 한 칸 밀어 첫 카드가 헤더에 가려지던 문제 차단.
                                    cardsRef.current?.focus({ preventScroll: true });
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
                        // 버튼 활성 조건은 그 둘 중 하나만 있으면 OK — .fs 경로/원본 PDF명이 없는 옛 건은
                        // .fs 자동매칭 대신 거래처 폴더만 열림(에이전트가 처리).
                        const fsReady = !!(it.networkFolderName || it.companyName);
                        // originalFsPath(워처가 못 박은 .fs 전체 경로) 나 originalPdfFilename 이 있으면
                        // 자동매칭 가능 — 둘 다 없는 옛 건은 버튼은 살리되 안내만 다르게(거래처 폴더만 열림).
                        const fsAutoMatch = fsReady && !!(it.originalFsPath || it.originalPdfFilename);
                        const isCompleted = !!worker
                            && Array.isArray(it.workerCompletions)
                            && it.workerCompletions.some((c) => c.worker === worker);
                        const opening = openingFs === it.orderNumber;
                        const openingDir = openingFolder === it.orderNumber;
                        const designatingThis = designating === it.orderNumber;
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
                                    {(it.worksheetPdfUrl || it.worksheetThumbnailUrl) && (
                                        <button
                                            type="button"
                                            className="fv-thumb-zoom"
                                            onClick={(e) => { e.stopPropagation(); setLightboxOrder(it.orderNumber); }}
                                            title="크게 보기"
                                            aria-label="작업지시서 크게 보기"
                                        >
                                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <circle cx="8.5" cy="8.5" r="5.5" />
                                                <path d="M13 13l4 4" />
                                            </svg>
                                        </button>
                                    )}
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
                                        {/* FS·폴더 버튼 — 마우스 클릭(e.detail>0)은 곧바로 실행하고,
                                            키보드 활성화(버튼에 Tab 포커스 후 Enter/Space → e.detail===0)는
                                            askOpen 으로 '여시겠습니까?' 확인창을 거친다. 키보드로 조작할 땐
                                            ↓ 선택·라이트박스와 마찬가지로 늘 한 번 물어보게 통일. */}
                                        <button
                                            type="button"
                                            className="fv-btn fv-btn-fs"
                                            onClick={(e) => (e.detail === 0 ? askOpen(it, 'fs') : handleOpenFs(it))}
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
                                            onClick={(e) => (e.detail === 0 ? askOpen(it, 'folder') : handleOpenFolder(it))}
                                            disabled={!fsReady || openingDir}
                                            title={!fsReady
                                                ? '거래처 정보가 비어 있어 폴더를 찾을 수 없습니다'
                                                : '이 지시서의 .fs(찾으면) 가 든 폴더를 탐색기로 엽니다'}
                                        >
                                            {openingDir ? '여는 중…' : '폴더열기'}
                                        </button>
                                        <button
                                            type="button"
                                            className="fv-btn fv-btn-designate"
                                            onClick={() => handleDesignate(it)}
                                            disabled={!fsReady || designatingThis}
                                            title={!fsReady
                                                ? '거래처 정보가 비어 있어 폴더를 찾을 수 없습니다'
                                                : '이 지시서로 쓸 .fs 파일을 직접 골라 고정합니다(이름 바꿔도 따라감). 옛 지시서·매칭이 틀릴 때 사용.'}
                                        >
                                            {designatingThis ? '지정 중…' : '파일지정'}
                                        </button>
                                        {it.worksheetPdfUrl && (
                                            <KakaoShareButton
                                                className="fv-btn-share"
                                                iconOnly
                                                getSource={() => ({ type: 'pdf', url: it.worksheetPdfUrl })}
                                                fileName={() => safeFileName(`${it.title || it.orderNumber || '지시서'}_지시서`, 'jpg')}
                                            />
                                        )}
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

            {lightboxOrder && (
                <WorksheetLightbox
                    items={sorted}
                    orderNumber={lightboxOrder}
                    onClose={closeLightbox}
                    onNavigate={setLightboxOrder}
                    onRequestOpen={askOpen}
                    confirmActive={!!openConfirm}
                />
            )}

            {openConfirm && (
                <div
                    className="fv-modal-bg fv-modal-bg--over"
                    onClick={() => setOpenConfirm(null)}
                >
                    <div className="fv-modal" onClick={(e) => e.stopPropagation()}>
                        <p className="fv-modal-desc" style={{ fontSize: 16, color: '#1f2937' }}>
                            [{openConfirm.item.title || openConfirm.item.orderNumber}] 작업지시서를 여시겠습니까?
                        </p>
                        <div className="fv-open-choices">
                            <button
                                type="button"
                                className={`fv-open-btn${openChoice === 'fs' ? ' on' : ''}`}
                                onClick={() => runOpenChoice('fs')}
                            >FS에서 열기</button>
                            <button
                                type="button"
                                className={`fv-open-btn${openChoice === 'folder' ? ' on' : ''}`}
                                onClick={() => runOpenChoice('folder')}
                            >폴더열기</button>
                        </div>
                        <p className="fv-open-hint">← → 로 선택 · Enter 로 열기 · Esc 취소</p>
                    </div>
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
