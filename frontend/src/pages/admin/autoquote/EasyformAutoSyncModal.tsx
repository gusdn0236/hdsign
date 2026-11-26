/**
 * 이지폼 저장 자동반영 — 확인 카드.
 *
 *  ① 비고에 이미 홈페이지 주문번호가 있으면(홈페이지에서 [이지폼 입력]했거나 예전에 이어 둔 명세서) 그 주문(들)의
 *     홈페이지 명세서를 이지폼 내용으로 덮어쓴다. 단, 홈페이지 저장본 밑에 **번호 없는 새 줄**이 붙었으면
 *     (다른 지시서 내용을 이어 쓴 합친 명세서일 수 있음) 그 줄이 어느 지시서인지 먼저 묻는다(사용자 2026-11-20).
 *     → 다른 지시서면 이지폼 새 줄 첫 행 비고에 그 번호를 적고 저장 + 두 지시서 합친 명세서로 반영.
 *  ② 번호가 없으면 발행일 근처 지시서를 거래처 닮음 순으로 카드로 보여 주고 "이 지시서가 맞나요?" →
 *     [맞아요] → 워처가 이지폼 비고에 주문번호를 적고 저장 → 홈페이지 명세서 덮어쓰기.
 * 이지폼이 참 데이터 — 홈페이지 명세서가 달라도 이지폼 내용으로 덮는다(사용자 결정 2026-11-20).
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import PdfViewerJs from '../../../components/common/PdfViewer.jsx';
import WorksheetThumbnailJs from '../../../components/common/WorksheetThumbnail.jsx';
import FitWorksheet from '../scrap/FitWorksheet';
import '../OrderAdmin.css'; // 지시서 고르기 카드 = 명세서 탭 카드와 같은 모양
import { useAuth } from '../../../context/AuthContext';
import {
  findOrdersByNumbers,
  getEasyformCandidates,
  getEstimate,
  syncEstimateFromEasyform,
  type EasyformCandidateOrder,
} from './annot/api';
import {
  backEfAuto,
  extractOrderNos,
  frontEfAuto,
  orderNoCore,
  stampEfAuto,
  type EfAutoEvent,
} from './data/easyformClient';
import { bandOwners, clientSim, efRowsToGrid, normClient, rememberClientAlias } from './data/efMatch';
import './EasyformAutoSync.css';
import { FailCopyButton } from '../../../components/common/FailCopy';
import { FAIL_COPY_GUIDE, isExpectedMiss } from '../../../utils/failReport';

// 추가한 줄 묻기 때 뒤에 '그 명세서' 화면을 미리보기로 깐다(사용자 2026-11-20: 명세서를 열어 추가된 줄 표시)
const AutoQuote = lazy(() => import('./AutoQuote'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PdfViewer = PdfViewerJs as unknown as ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WorksheetThumbnail = WorksheetThumbnailJs as unknown as ComponentType<any>;

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
/** 명세서 탭 카드와 같은 납기 글자 'MM-DD (요일)' */
function dueText(s: string | null | undefined): string {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '납기 없음';
  return `${m[2]}-${m[3]} (${WEEK[new Date(+m[1], +m[2] - 1, +m[3]).getDay()]})`;
}
/** 명세서 탭 카드와 같은 납기 배지 — 오늘/내일/n일 지남 */
function dueBadge(s: string | null | undefined): { kind: string; text: string } | null {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(+m[1], +m[2] - 1, +m[3]).getTime() - t.getTime()) / DAY);
  if (diff < 0) return { kind: 'overdue', text: `${-diff}일 지남` };
  if (diff === 0) return { kind: 'today', text: '오늘' };
  if (diff === 1) return { kind: 'tomorrow', text: '내일' };
  return null;
}

interface Props {
  ev: EfAutoEvent;
  token: string | null | undefined;
  more: number; // 뒤에 기다리는 저장 수
  onClose: () => void;
}

// check = 비고 번호 있음 → 새 줄 확인 중 / added = 새 줄이 어느 지시서인지 묻는 중 / pick = 지시서 고르기
// assign = 지시서 여러 개 → 하나씩 '명세서에서 이 지시서가 시작하는 줄' 고르기(사용자 2026-11-25)
type Phase = 'confirm' | 'check' | 'added' | 'pick' | 'assign' | 'saving' | 'done' | 'error';

/** 지시서마다 줄 고르기. own[줄] = 그 줄이 든 지시서 번호(orders 의 k). 줄 = 이지폼 표 줄(ev.rows 기준).
 *  클릭 = 그 줄 선택/해제, 드래그 = 여러 줄(사용자 2026-11-25). 한 줄엔 지시서 하나만. */
interface Assign {
  orders: EasyformCandidateOrder[];
  own: Record<number, number>;
  step: number;
  orderNumbers: string[]; // 홈페이지에 묶을 순서(맨 앞 = 대표)
}

const DAY = 86400000;
function dayOf(s: string | null | undefined): number | null {
  const m = String(s || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
function fmtDay(s: string | null | undefined): string {
  const m = String(s || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  return m ? `${+m[2]}월 ${+m[3]}일` : '';
}
function won(s: string | number): string {
  const n = Number(String(s).replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}원` : String(s);
}
/** 줄 비교용 — 품목코드·품목·규격·수량·단가(공백·콤마 무시). 백엔드 gridSig 와 같은 칸. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sig(r: any): string {
  const t = (v: unknown) => String(v ?? '').replace(/,/g, '').trim();
  return [t(r?.품목코드), t(r?.품목), t(r?.규격), t(r?.수량), t(r?.단가)].join('\u0001');
}

/** '홈페이지와 이미 같아요' 판단용 — 표시 차이는 같게(빈 수량·단가 '0'=빈칸, 단가 있는데 수량 빈칸 = 1). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sameSig(r: any): string {
  const t = (v: unknown) => String(v ?? '').replace(/,/g, '').replace(/\s+/g, ' ').trim();
  let q = t(r?.수량);
  let p = t(r?.단가);
  if (/^0+$/.test(p)) p = '';
  if (/^0+$/.test(q)) q = '';
  if (p && !q) q = '1';
  return [t(r?.품목코드), t(r?.품목), t(r?.규격), q, p].join('\u0001');
}

/** 내용 있는 줄(워처 bulk._has_content 와 같은 규칙) — 빈 줄은 시작 줄로 못 고름 */
function hasContent(r: { item_code?: string; item?: string; spec?: string; unit_price?: string }): boolean {
  return [r.item_code, r.item, r.spec].some((v) => (v || '').trim()) || !['', '0'].includes((r.unit_price || '').trim());
}

interface Ranked {
  o: EasyformCandidateOrder;
  sim: number;
  gap: number;
}

/** 새로 붙은 줄 — 홈페이지 저장본이 이지폼 앞줄과 똑같고 밑에 줄이 더 있을 때. */
interface Added {
  idx: number[]; // 표(그리드) 기준 새 줄들(저장본에 없는 줄)
  evRow: number; // 이지폼 표 기준 첫 새 줄(비고 적을 곳)
  count: number;
  base: EasyformCandidateOrder; // 원래 지시서(비고 번호의 첫 주문)
  members: EasyformCandidateOrder[]; // 이 명세서에 이미 든 지시서들(합친 명세서면 여럿)
}

export default function EasyformAutoSyncModal({ ev, token, more, onClose: drop }: Props) {
  // 닫을 땐 언제나 이지폼 명세서 창으로 돌아간다(직원은 이지폼에서 일하던 중 — 사용자 2026-11-20)
  const onClose = useCallback(() => {
    backEfAuto(ev.id);
    drop();
  }, [ev.id, drop]);
  const [ready, setReady] = useState(false); // 이 탭이 앞으로 나왔음 → 그때부터 반영 시작
  const { token: ctxToken } = useAuth();
  const tk = token || ctxToken;
  // 비고에 번호가 있어도 바로 반영하지 않고 매번 지시서를 확인(사용자 2026-11-24) — 같은 지시서면 그대로,
  // 이 명세서를 같이 쓰는 지시서가 있으면 더 골라 합친 명세서로 묶는다.
  const [phase, setPhase] = useState<Phase>(ev.nos.length ? 'confirm' : 'pick');
  const [cands, setCands] = useState<EasyformCandidateOrder[] | null>(null); // null = 불러오는 중
  const [days, setDays] = useState(7);
  const [showAll, setShowAll] = useState(false);
  // 다른 지시서 더하기 = '같은 거래처' 지시서만(발행일 앞뒤 60일, 넓히면 120일). 일주일 넘게 지난 현장 건에 다음 주
  // 추가 발주를 같이 끊는 경우가 있어 날짜보다 거래처로 찾고, 다른 거래처를 같이 끊는 일은 없음(사용자 2026-11-20).
  const [clientDays, setClientDays] = useState(60);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<EasyformCandidateOrder | null>(null); // 추가한 줄 고르기(하나)
  const [extra, setExtra] = useState<EasyformCandidateOrder[]>([]); // 고르기·확인 화면에서 고른 지시서(여럿 = 묶기)
  const [linked, setLinked] = useState<EasyformCandidateOrder[] | null>(null); // 비고에 적힌 지시서
  // '이 지시서가 맞나요?' 한 번 더 확인(추가한 줄 고르기에서 같은/다른 지시서 모두) — 사용자 결정 2026-11-20
  const [ask, setAsk] = useState<{ o: EasyformCandidateOrder; run: () => void } | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [other, setOther] = useState(false); // 새 줄 = 다른 지시서 → 고르기 목록 펼침
  const [zoom, setZoom] = useState<EasyformCandidateOrder | null>(null); // 🔍 지시서 크게 보기
  const [msg, setMsg] = useState<{ main: string; sub?: string; warn?: string }>({ main: '' });
  const [assign, setAssign] = useState<Assign | null>(null);
  const baseRef = useRef<EasyformCandidateOrder | null>(null); // 비고 번호의 (첫) 지시서

  // 이지폼 표 줄 ↔ 홈페이지 그리드 줄(빈 줄은 그리드에서 빠짐)
  const pairs = useMemo(
    () => ev.rows.map((r, i) => ({ i, g: efRowsToGrid([r])[0] })).filter((p) => !!p.g),
    [ev.rows],
  );
  const grid = useMemo(() => pairs.map((p) => p.g), [pairs]);
  const contentRows = useMemo(() => ev.rows.map((r, i) => ({ r, i })).filter(({ r }) => hasContent(r)), [ev.rows]);
  const sum = useMemo(() => grid.reduce((a, r) => a + (Number(r.공급가액) || 0), 0), [grid]);

  // 이 창이 떠 있는 동안 뒤 홈페이지는 스크롤 안 되게(끝까지 내리면 뒤가 따라 내려가던 것 — 사용자 2026-11-24)
  useEffect(() => {
    const b = document.body;
    const old = b.style.overflow;
    b.style.overflow = 'hidden';
    return () => {
      b.style.overflow = old;
    };
  }, []);

  // 직원은 이지폼을 보고 있다 → 이 탭 제목에 표시를 달고 워처에게 이 창을 앞으로 가져오게 한다.
  useEffect(() => {
    const old = document.title;
    const mark = `이지폼 명세서 확인 #${ev.id}`;
    document.title = `🧾 ${mark} · HD Sign 관리자`; // 관리자 표시는 남겨 둔다(워처가 탭을 찾는 이름)
    let alive = true;
    (async () => {
      // 워처가 이 창을 앞으로 — 다른 탭 뒤에 숨어 있으면 Chrome 탭 목록에서 이 탭을 골라 앞으로(새 탭은 안 엶:
      // 관리자 로그인이 탭마다라 새 탭은 다시 로그인해야 함, 사용자 2026-11-20). 못 띄워도 카드는 여기 그대로.
      await frontEfAuto(mark);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
      document.title = old;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev.id]);

  /** 반영. stamp = 이지폼 비고에 먼저 적을 것(지시서·번호·줄). 못 적어도 홈페이지 반영은 한다. */
  const save = useCallback(
    async (
      orderNumbers: string[],
      stamp?: { o: EasyformCandidateOrder; row?: number; move?: boolean; nos?: string[]; places?: { row: number; no: string }[] },
    ) => {
      setPhase('saving');
      let rows = ev.rows;
      let warn = '';
      if (stamp) {
        const no = orderNoCore(stamp.o.orderNumber);
        const st = await stampEfAuto(ev.id, stamp.nos?.length ? stamp.nos : [no], stamp.row, !!stamp.move, stamp.places);
        if (st.ok && Array.isArray(st.rows) && st.rows.length === rows.length) {
          rows = st.rows; // 워처가 비고(적기·옮기기) 반영한 줄들
        } else if (st.ok && !st.skipped && typeof st.row === 'number' && rows[st.row]) {
          rows = rows.map((r, i) => (i === st.row ? { ...r, remark: st.remark || no } : r));
        } else if (!st.ok && stamp.move) {
          warn = `이지폼 비고의 주문번호를 맨 위로 못 옮겼어요 — ${st.message || '알 수 없는 이유'}`;
        } else if (!st.ok) {
          warn = `이지폼 비고엔 주문번호를 못 적었어요 — ${st.message || '알 수 없는 이유'}`;
          if (stamp.places?.length) {
            // 홈페이지에선 고른 구간대로 보이게 — 옛 자리 번호는 빼고 고른 줄에 번호
            const places = stamp.places;
            const all = places.map((p) => p.no);
            rows = rows.map((r, i) => {
              const keep = (r.remark || '')
                .split(/([\s,]+)/)
                .filter((t) => !all.includes(t))
                .join('')
                .replace(/^[\s,]+|[\s,]+$/g, '');
              const mine = places.filter((p) => p.row === i).map((p) => p.no);
              return { ...r, remark: [keep, ...mine].filter(Boolean).join(' ') };
            });
          } else if (typeof stamp.row === 'number' && rows[stamp.row]) {
            // 홈페이지에선 구간이 맞게 보이도록 그 줄 비고에 번호를 넣어 둔다
            rows = rows.map((r, i) => (i === stamp.row ? { ...r, remark: `${(r.remark || '').trim()} ${no}`.trim() } : r));
          }
        }
      }
      try {
        const g = efRowsToGrid(rows);
        const res = await syncEstimateFromEasyform(tk, {
          orderNumbers,
          grid: g,
          total: g.reduce((a, r) => a + (Number(r.공급가액) || 0), 0),
          source: 'auto',
          efDate: ev.date,
          efTotal: ev.total,
          efClient: ev.client, // OCR — 한두 글자 틀릴 수 있음
          efBiz: ev.biz,
        });
        if (stamp && stamp.row === undefined && ev.client) rememberClientAlias(stamp.o.clientCompanyName, ev.client);
        const nos = res.linked.map((l) => orderNoCore(l.orderNumber));
        // 명세서 탭 카드에 바로 '명세서 완료' 표시 + 목록 새로고침(OrderAdmin 이 받음)
        window.dispatchEvent(new CustomEvent('hd:efauto-saved', { detail: { ids: res.linked.map((l) => l.id) } }));
        setMsg({
          main: '홈페이지 명세서에 반영했어요',
          sub: `${nos.length > 1 ? '합친 명세서 ' : '주문 '}${nos.join(', ')}${res.changed ? '' : ' · 바뀐 내용 없음'}`,
          warn,
        });
        setPhase('done');
        return true;
      } catch (e) {
        setMsg({ main: '홈페이지에 반영하지 못했어요', sub: (e as Error).message, warn });
        setPhase('error');
        return false;
      }
    },
    [ev, tk],
  );

  // ① 비고에 번호 → 홈페이지 저장본과 비교: 밑에 번호 없는 새 줄이 붙었으면 묻고, 아니면 바로 반영.
  useEffect(() => {
    if (!ready || phase !== 'check') return;
    (async () => {
      try {
        const orders = await findOrdersByNumbers(tk, ev.nos);
        const base = orders.find((o) => orderNoCore(o.orderNumber) === ev.nos[0]);
        baseRef.current = base || null;
        const est = base ? await getEstimate(tk, base.id).catch(() => null) : null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const saved = ((est?.estimate?.grid || []) as any[]).filter((r) => sig(r).replace(/\u0001/g, ''));
        const n = saved.length;
        // 위치가 아니라 **내용으로** 비교 — 저장본에 같은 줄(5칸)이 있으면 지운다(같은 줄 여러 개면 개수만큼).
        // 맨 위·중간에 끼운 줄이나 기존 줄을 고친 것도 '저장본에 없는 줄'로 잡힌다(사용자 2026-11-20: ✕ 뒤 고쳐 저장하니 안 물음).
        const left = new Map<string, number>();
        saved.forEach((r) => left.set(sig(r), (left.get(sig(r)) || 0) + 1));
        const fresh: number[] = [];
        pairs.forEach((p, k) => {
          const c = left.get(sig(p.g)) || 0;
          if (c > 0) left.set(sig(p.g), c - 1);
          else fresh.push(k);
        });
        const freshHasNo = fresh.some((k) => extractOrderNos(ev.rows[pairs[k].i]?.remark || '').length);
        // 홈페이지와 줄 내용·순서가 똑같으면(예: 홈페이지 → 이지폼 반영 뒤 고친 것 없이 저장을 또 누름) 아무것도 안 한다 —
        // 이지폼 비고 다시 적기·홈페이지 덮어쓰기(말풍선 위치 정보 빠짐) 둘 다 건너뜀(사용자 2026-11-23).
        // 합친 명세서는 비고 번호를 옮긴 경우('moved')를 먼저 반영하고, 안 옮겼을 때만 여기로.
        const identical =
          !!base && n > 0 && n === pairs.length && saved.every((r, k) => sameSig(r) === sameSig(pairs[k].g));
        const sameDone = () => {
          setMsg({ main: '홈페이지와 이미 같아요', sub: `주문 ${ev.nos.join(', ')} · 반영할 내용이 없어요` });
          setPhase('done');
        };
        if (identical && ev.nos.length === 1) {
          sameDone();
          return;
        }
        // 합친 명세서에서 직원이 비고의 주문번호를 **직접 옮겼으면**(번호가 붙은 줄이 저장본과 다름) = 지시서 구간을
        // 바꾼 것 → 묻지도 고치지도 않고 이지폼 그대로 반영. 구간(명세서 화면 'n번째 지시서' 흐림)은 비고 번호 위치를
        // 따라가므로 저장하면 그대로 맞춰진다(사용자 2026-11-20). 줄만 끼웠으면 번호는 원래 줄에 붙어 있어 여기 안 걸림.
        if (ev.nos.length > 1 && n > 0) {
          const placed = new Set<string>();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          saved.forEach((r: any) => extractOrderNos(String(r?.비고 || '')).forEach((no) => placed.add(`${sig(r)}|${no}`)));
          const moved = pairs.some((p) =>
            extractOrderNos(ev.rows[p.i]?.remark || '').some((no) => !placed.has(`${sig(p.g)}|${no}`)),
          );
          if (moved) {
            const ok = await save(ev.nos);
            if (!ok) setPhase('pick');
            return;
          }
        }
        if (identical) {
          sameDone();
          return;
        }
        // 줄 수가 늘었을 때만 묻는다(고치기만 했으면 같은 지시서 — 바로 반영)
        if (base && n > 0 && pairs.length > n && fresh.length && !freshHasNo) {
          const members = ev.nos
            .map((no) => orders.find((o) => orderNoCore(o.orderNumber) === no))
            .filter((o): o is EasyformCandidateOrder => !!o);
          setAdded({ idx: fresh, evRow: pairs[fresh[0]].i, count: fresh.length, base, members: members.length ? members : [base] });
          setPhase('added');
          return;
        }
      } catch {
        /* 확인 못 하면 예전처럼 바로 반영 */
      }
      // 지시서 1개짜리면 번호를 맨 위(비고 빈 첫 줄)로 맞춰 둔다 — 맨 위에 줄을 끼우면 밀리므로(사용자 2026-11-20)
      const one = ev.nos.length === 1 ? baseRef.current : null;
      const ok = await save(ev.nos, one ? { o: one, move: true } : undefined);
      if (!ok) setPhase('pick'); // 홈페이지에서 그 번호를 못 찾음 → 직접 고르기
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, phase === 'check']);

  // 확인 화면 — 비고에 적힌 지시서 카드
  useEffect(() => {
    if (!ready || phase !== 'confirm' || linked) return;
    findOrdersByNumbers(tk, ev.nos)
      .then((os) => setLinked(ev.nos.map((no) => os.find((o) => orderNoCore(o.orderNumber) === no)).filter((o): o is EasyformCandidateOrder => !!o)))
      .catch(() => setLinked([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, phase]);

  // 후보 지시서 — 고르기 화면이나 새 줄 묻기 화면에서
  useEffect(() => {
    if (!ready || (phase !== 'pick' && phase !== 'added' && phase !== 'confirm')) return;
    let alive = true;
    setCands(null);
    const sameClient = phase === 'added' && added;
    getEasyformCandidates(tk, ev.date, sameClient ? clientDays : days, sameClient ? added.base.id : undefined)
      .then((list) => alive && setCands(list))
      .catch((e) => {
        if (!alive) return;
        setMsg({ main: '지시서 후보를 못 불러왔어요', sub: (e as Error).message });
        setPhase('error');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, phase === 'pick' || phase === 'added' || phase === 'confirm', days, clientDays]);

  // 다 끝나도 자동으로 닫지 않음 — 사용자가 [확인]을 눌러야 이지폼으로 돌아감(사용자 결정 2026-11-20)

  const ranked: Ranked[] = useMemo(() => {
    const d0 = dayOf(ev.date);
    const skip = new Set(phase === 'added' || phase === 'confirm' ? ev.nos : []); // 이미 든 지시서는 후보에서 빼고
    // 새 줄 묻기에선 원래 지시서 거래처와 닮음(OCR 보다 정확)
    const who = phase === 'added' && added ? added.base.clientCompanyName || ev.client : ev.client;
    const score = (r: Ranked) => r.sim * 10 - r.gap * 0.6 - (r.o.hasEstimate ? 1 : 0);
    return (cands || [])
      .filter((o) => !skip.has(orderNoCore(o.orderNumber)))
      .map((o) => {
        const d = dayOf(o.dueDate) ?? dayOf(o.createdAt);
        return { o, sim: clientSim(o.clientCompanyName, who || ''), gap: d0 != null && d != null ? Math.round(Math.abs(d - d0) / DAY) : 99 };
      })
      .sort((a, b) => score(b) - score(a));
  }, [cands, ev.date, ev.client, ev.nos, phase, added]);

  const visible = useMemo(() => {
    const needle = normClient(q);
    if (needle) {
      return ranked.filter(
        (r) => normClient(r.o.clientCompanyName).includes(needle) || (r.o.orderNumber || '').includes(q.trim()) || normClient(r.o.title).includes(needle),
      );
    }
    if (phase === 'added' && added) {
      // 합친 명세서에 더하는 지시서 = **같은 거래처만**(다른 거래처를 같이 끊는 일은 없음, 사용자 2026-11-20)
      const mine = normClient(added.base.clientCompanyName);
      return ranked.filter((r) => normClient(r.o.clientCompanyName) === mine);
    }
    if (showAll) return ranked;
    const good = ranked.filter((r) => r.sim >= 0.5);
    return good.length ? good : ranked;
  }, [ranked, q, showAll, phase, added]);
  const hiddenCount = ranked.length - visible.length;
  const clientKnown = ranked.some((r) => r.sim >= 0.5);

  const toggle = (o: EasyformCandidateOrder) =>
    setExtra((xs) => (xs.some((x) => x.id === o.id) ? xs.filter((x) => x.id !== o.id) : [...xs, o]));
  // 비고 번호가 적힌 줄(거기 뒤에 더 고른 번호를 붙여 적음)
  const holderRow = ev.rows.findIndex((r) => extractOrderNos(r.remark || '').length > 0);
  const confirm = () => {
    if (phase === 'confirm') {
      if (!extra.length) {
        // 비고에 지시서가 여러 개면 매번 줄 고르기 화면(지금 구간이 미리 골라져 있음) — 구간을 다시 잡으려고 저장했는데
        // '이미 같아요'로 끝나 버리던 것(사용자 2026-11-25). 구간을 안 바꾸고 넘기면 예전처럼 비교만 한다.
        if (ev.nos.length > 1 && linked && linked.length === ev.nos.length) {
          startAssign(linked, [...ev.nos]);
          return;
        }
        setPhase('check'); // 같은 지시서 — 예전처럼 비교해서 반영(같으면 '이미 같아요')
        return;
      }
      const nos = extra.map((o) => orderNoCore(o.orderNumber));
      // 비고에 적힌 지시서를 다 찾았으면 지시서마다 시작 줄을 고르게, 못 찾았으면 예전처럼(번호 줄 뒤에 붙임)
      if (linked && linked.length === ev.nos.length) {
        startAssign([...linked, ...extra], [...ev.nos, ...nos]);
        return;
      }
      save([...ev.nos, ...nos], { o: extra[0], nos, row: holderRow >= 0 ? holderRow : undefined });
      return;
    }
    if (phase === 'pick') {
      if (!extra.length) return;
      const nos = extra.map((o) => orderNoCore(o.orderNumber));
      if (extra.length > 1) {
        startAssign(extra, nos);
        return;
      }
      save(nos, { o: extra[0], nos });
      return;
    }
    if (!picked) return;
    if (phase === 'added' && added) {
      // 새 줄 = 다른 지시서 → 이지폼 새 줄 첫 행 비고에 그 번호 + 합친 명세서(원래 번호들 먼저 = 대표 유지)
      const o = picked;
      setAsk({ o, run: () => save([...ev.nos, orderNoCore(o.orderNumber)], { o, row: added.evRow }) });
    }
  };

  // ── 지시서마다 시작 줄 고르기 ──
  function startAssign(orders: EasyformCandidateOrder[], orderNumbers: string[]) {
    // 비고에 이미 적힌 구간(그 번호부터 다음 번호 전까지 / 여러 줄에 적힌 번호는 그 줄들)을 미리 골라 둔다
    const nos = orders.map((o) => orderNoCore(o.orderNumber));
    const band = bandOwners(ev.rows.map((r) => r.remark || ''), nos);
    const own: Record<number, number> = {};
    contentRows.forEach(({ i }) => {
      const k = band[i] ? nos.indexOf(band[i] as string) : -1;
      if (k >= 0) own[i] = k;
    });
    setAssign({ orders, own, step: 0, orderNumbers });
    setPhase('assign');
  }
  // 드래그 — 누른 줄(anchor)부터 지금 줄까지(표 순서). 놓을 때 적용: 그 범위가 전부 이 지시서면 해제, 아니면 전부 선택.
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const dragRef = useRef<{ a: number; b: number } | null>(null);
  const applyRange = (a: number, b: number) =>
    setAssign((x) => {
      if (!x) return x;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const rows = contentRows.slice(lo, hi + 1).map((c) => c.i);
      const own = { ...x.own };
      const allMine = rows.every((i) => own[i] === x.step);
      rows.forEach((i) => {
        if (allMine) delete own[i];
        else own[i] = x.step; // 다른 지시서 줄이었으면 이 지시서로 옮김
      });
      return { ...x, own };
    });
  useEffect(() => {
    if (!drag) return undefined;
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d) applyRange(d.a, d.b);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);
  const owners = useMemo(() => {
    const out = new Map<number, number>();
    if (assign) Object.entries(assign.own).forEach(([i, k]) => out.set(Number(i), k));
    return out;
  }, [assign]);
  const countOf = (k: number) => (assign ? Object.values(assign.own).filter((x) => x === k).length : 0);
  const assignDone = !!assign && assign.orders.every((_, k) => countOf(k) > 0);
  /** 이지폼 비고에 적을 곳. 지시서 줄이 한 덩어리이고 바로 밑이 끝이거나 다른 지시서 줄이면 첫 줄에만(밑으로 이어짐),
   *  아니면(떨어져 있거나 밑에 안 고른 줄) 고른 줄마다 적는다 — 명세서 화면 구간(bandOwners)과 같은 규칙. */
  const assignPlaces = (a: Assign) => {
    const pos = new Map(contentRows.map((c, n) => [c.i, n]));
    const places: { row: number; no: string }[] = [];
    a.orders.forEach((o, k) => {
      const no = orderNoCore(o.orderNumber);
      const rows = contentRows.filter((c) => a.own[c.i] === k).map((c) => c.i);
      if (!rows.length) return;
      const first = pos.get(rows[0]) as number;
      const last = pos.get(rows[rows.length - 1]) as number;
      const oneRun = last - first + 1 === rows.length;
      const next = contentRows[last + 1];
      const closed = !next || a.own[next.i] != null;
      (oneRun && closed ? [rows[0]] : rows).forEach((row) => places.push({ row, no }));
    });
    return places.sort((x, y) => x.row - y.row);
  };
  const assignNext = () => {
    if (!assign) return;
    if (assign.step < assign.orders.length - 1) {
      setAssign({ ...assign, step: assign.step + 1 });
      return;
    }
    if (!assignDone) {
      setAssign({ ...assign, step: assign.orders.findIndex((_, k) => countOf(k) === 0) });
      return;
    }
    const places = assignPlaces(assign);
    // 비고 번호 자리가 지금과 똑같으면(구간 안 바꿈) 적을 게 없음 → 예전처럼 내용만 비교(같으면 '이미 같아요')
    const nos = assign.orders.map((o) => orderNoCore(o.orderNumber));
    const unchanged = ev.rows.every((r, i) => {
      const now = extractOrderNos(r.remark || '').filter((n) => nos.includes(n)).sort().join(',');
      const want = places.filter((p) => p.row === i).map((p) => p.no).sort().join(',');
      return now === want;
    });
    if (unchanged && assign.orderNumbers.length === ev.nos.length) {
      setPhase('check');
      return;
    }
    save(assign.orderNumbers, { o: assign.orders[0], nos: assign.orders.map((o) => orderNoCore(o.orderNumber)), places });
  };

  const busy = phase === 'saving' || phase === 'check';
  const choosing = phase === 'pick' || phase === 'confirm' || (phase === 'added' && other); // 지시서 카드 목록을 보여줄 때
  const title =
    phase === 'pick' || phase === 'confirm'
      ? '어느 지시서인지 선택해주세요'
      : phase === 'assign' && assign
        ? `${assign.step + 1}번째 지시서 — 해당되는 줄을 클릭 or 드래그해서 선택해주세요`
        : phase === 'added'
        ? `추가한 ${added?.count}줄은 어느 지시서 건가요?`
        : phase === 'done' || phase === 'error'
          ? msg.main
          : '홈페이지에 반영하는 중…';
  const who = ev.client || added?.base.clientCompanyName || '';
  const price = (v: string) => (v ? `${Number(v.replace(/,/g, '')).toLocaleString('ko-KR')}원` : '');
  const preview = useMemo(
    () =>
      added
        ? {
            rows: grid.map((r) => ({ 품목코드: r.품목코드, 품목: r.품목, 규격: r.규격, 수량: r.수량, 단가: r.단가, 비고: r.비고 })),
            newRows: added.idx,
          }
        : undefined,
    [added, grid],
  );
  /** 추가한 줄 = 이 명세서에 이미 든 지시서 o. 지시서 1개면 번호 맨 위 맞추기만, 합친 명세서면 그 줄 바로 위 구간의
   *  지시서와 다를 때만 추가한 줄 첫 행 비고에 o 번호를 적어 구간을 나눈다. */
  const memberSave = (o: EasyformCandidateOrder) => setAsk({ o, run: () => memberSaveNow(o) });
  const memberSaveNow = (o: EasyformCandidateOrder) => {
    if (!added) return;
    if (ev.nos.length === 1) {
      save(ev.nos, { o, move: true });
      return;
    }
    let owner = ev.nos[0];
    for (let i = added.evRow - 1; i >= 0; i--) {
      const ns = extractOrderNos(ev.rows[i]?.remark || '');
      if (ns.length) {
        owner = ns[ns.length - 1];
        break;
      }
    }
    if (orderNoCore(o.orderNumber) === owner) save(ev.nos);
    else save(ev.nos, { o, row: added.evRow });
  };

  // 지시서 카드(명세서 탭과 같은 모양). locked = 비고에 이미 적힌 지시서(늘 골라져 있음)
  const pick = (o: EasyformCandidateOrder) => (phase === 'added' ? setPicked(o) : toggle(o));
  const isOn = (o: EasyformCandidateOrder) => (phase === 'added' ? picked?.id === o.id : extra.some((x) => x.id === o.id));
  const card = (o: EasyformCandidateOrder, locked = false) => {
    const on = locked || isOn(o);
    const badge = dueBadge(o.dueDate);
    return (
      <div
        key={o.id}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        className={`order-card order-card--order${o.hasEstimate ? ' order-card--estimate' : ''}${on ? ' efas-card-on' : ''}${locked ? ' efas-card-locked' : ''}`}
        onClick={() => (locked ? undefined : pick(o))}
        onDoubleClick={() => {
          setZoom(o);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !locked) {
            e.preventDefault();
            pick(o);
          }
        }}
      >
        <div className="order-card-thumb-wrap">
          <WorksheetThumbnail
            pdfUrl={o.worksheetPdfUrl || null}
            thumbnailUrl={o.worksheetThumbnailUrl || null}
            fallback={
              <div className="order-card-thumb-empty">
                <span className="order-card-thumb-empty-title">{o.title || '지시서 없음'}</span>
              </div>
            }
          />
          {(o.hasEstimate || o.deletedAt) && (
            <div className="order-card-thumb-badges">
              {o.hasEstimate && <span className="row-badge badge-estimate">명세서 있음</span>}
              {o.deletedAt && <span className="row-badge badge-evidence">작업완료</span>}
            </div>
          )}
          {on && (
            <span className="efas-card-check" aria-hidden="true">
              ✓
            </span>
          )}
          {locked && <span className="efas-card-lockt">비고에 적힌 지시서</span>}
          <button
            type="button"
            className="efas-zoombtn"
            onClick={(e) => {
              e.stopPropagation();
              setZoom(o);
            }}
            aria-label={`${orderNoCore(o.orderNumber)} 지시서 크게 보기`}
            title="크게 보기"
          >
            🔍
          </button>
        </div>
        <div className="order-card-body">
          <div className="order-card-meta-row">
            <span className="order-card-company">{o.clientCompanyName || '-'}</span>
            <span className="order-card-due">
              {badge && <span className={`due-badge due-badge--${badge.kind}`}>{badge.text}</span>}
              <span className="order-due-text">{dueText(o.dueDate)}</span>
            </span>
          </div>
          <h3 className="order-card-title">{o.title || '지시서'}</h3>
          <div className="order-card-foot">
            <span className="order-card-foot-left">
              <span className="order-card-num">{o.orderNumber}</span>
            </span>
            <span className="order-card-date">{(o.createdAt || '').split('T')[0]}</span>
          </div>
        </div>
      </div>
    );
  };

  const onAq = !!added && phase !== 'pick' && phase !== 'confirm'; // 뒤에 명세서 미리보기를 깔 때

  return (
    <>
      {onAq && added && (
        <div className="aq-modal-overlay efas-aqwrap" aria-hidden="true">
          <Suspense fallback={null}>
            <AutoQuote orderId={added.base.id} efPreview={preview} onClose={onClose} />
          </Suspense>
        </div>
      )}
    <div className={'efas' + (onAq ? ' on-aq' : '') + (onAq && other ? ' picking' : '')} role="dialog" aria-modal="true" aria-label="이지폼 명세서 홈페이지 반영">
      <div className="efas-card">
        <header className="efas-head">
          <div>
            {phase !== 'pick' && phase !== 'confirm' && (
              <p className="efas-kicker">
                이지폼 명세서{who ? ` · ${who}` : ''} · {fmtDay(ev.date)}
                {more > 0 && <span className="efas-more">+{more}건 대기</span>}
              </p>
            )}
            <h2 className={'efas-title' + (phase === 'pick' || phase === 'confirm' ? ' big' : '')}>{title}</h2>
          </div>
          <button type="button" className="efas-x" onClick={onClose} disabled={phase === 'saving'} aria-label="닫기">
            ✕
          </button>
        </header>

        {phase === 'added' && added ? (
          // 추가한 줄만 크게
          <section className="efas-newbox" aria-label="추가한 줄">
            <p className="efas-newbox-label">추가한 줄</p>
            <table>
              <tbody>
                {grid.filter((_, k) => added.idx.includes(k)).map((r, i) => (
                  <tr key={i}>
                    <td>{r.품목 || r.품목코드}</td>
                    <td>{r.규격}</td>
                    <td className="num">{r.수량}</td>
                    <td className="num">{price(r.단가)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : phase === 'pick' || phase === 'confirm' ? null : phase === 'assign' && assign ? (
          <section className="efas-assign" aria-label="지시서마다 시작 줄 고르기">
            <div className="efas-assign-steps">
              {assign.orders.map((o, k) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={k === assign.step}
                  className={`efas-step c${k % 6}${k === assign.step ? ' on' : ''}${countOf(k) > 0 ? ' set' : ''}`}
                  onClick={() => setAssign({ ...assign, step: k })}
                >
                  <i>{k + 1}</i>
                  {orderNoCore(o.orderNumber)}
                  {countOf(k) > 0 && <small>{countOf(k)}줄</small>}
                </button>
              ))}
            </div>
            <div className="efas-assign-body">
              <div className="efas-assign-ws">
                <div className="efas-assign-wsimg">
                  <FitWorksheet
                    key={assign.orders[assign.step].id}
                    pdfUrl={assign.orders[assign.step].worksheetPdfUrl}
                    thumbUrl={assign.orders[assign.step].worksheetThumbnailUrl}
                    title={assign.orders[assign.step].title}
                  />
                  <button
                    type="button"
                    className="efas-zoombtn"
                    onClick={() => setZoom(assign.orders[assign.step])}
                    aria-label="지시서 크게 보기"
                    title="크게 보기"
                  >
                    🔍
                  </button>
                </div>
                <p className="efas-assign-name">
                  <span className={`efas-tagchip c${assign.step % 6}`}>{assign.step + 1}</span>
                  <b>{orderNoCore(assign.orders[assign.step].orderNumber)}</b>
                  {assign.orders[assign.step].title ? ` · ${assign.orders[assign.step].title}` : ''}
                </p>
              </div>
              <div className="efas-assign-stmt">
                <p className="efas-assign-help">
                  해당되는 줄을 <b>클릭 or 드래그</b>해서 선택해주세요. 다시 클릭하면 해제, 이미 고른 줄을 드래그하면 그 줄들이 해제돼요.
                </p>
                <div className="efas-assign-table">
                  <table>
                    <thead>
                      <tr>
                        <th className="num">행</th>
                        <th>품목</th>
                        <th>규격</th>
                        <th className="num">수량</th>
                        <th className="num">단가</th>
                        <th>지시서</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contentRows.map(({ r, i }, n) => {
                        const own = owners.get(i);
                        const prevOwn = n > 0 ? owners.get(contentRows[n - 1].i) : undefined;
                        const head = own != null && own !== prevOwn; // 이 지시서 덩어리의 첫 줄
                        const inDrag = !!drag && n >= Math.min(drag.a, drag.b) && n <= Math.max(drag.a, drag.b);
                        return (
                          <tr
                            key={i}
                            className={`${own != null ? `own c${own % 6}` : ''}${head ? ' start' : ''}${own === assign.step ? ' mine' : ''}${inDrag ? ' dragging' : ''}`}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              e.preventDefault(); // 글자 선택 안 되게
                              dragRef.current = { a: n, b: n };
                              setDrag({ a: n, b: n });
                            }}
                            onMouseEnter={() => {
                              if (!dragRef.current) return;
                              dragRef.current = { ...dragRef.current, b: n };
                              setDrag({ ...dragRef.current });
                            }}
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                applyRange(n, n);
                              }
                            }}
                          >
                            <td className="num">{i + 1}</td>
                            <td>{r.item || r.item_code}</td>
                            <td>{r.spec}</td>
                            <td className="num">{r.qty}</td>
                            <td className="num">{price(r.unit_price || '')}</td>
                            <td className="tag">
                              {head ? (
                                <span className={`efas-tagchip c${(own as number) % 6}`}>
                                  {(own as number) + 1} · {orderNoCore(assign.orders[own as number].orderNumber)}
                                </span>
                              ) : own != null ? (
                                <span className="efas-tagdot">{own + 1}</span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {owners.size > 0 && owners.size < contentRows.length && (
                  <p className="efas-assign-warn">{contentRows.length - owners.size}줄이 어느 지시서에도 안 들어가 있어요.</p>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="efas-stmt" aria-label="이지폼 명세서">
            <div className="efas-stmt-meta">
              <span className="efas-client">{ev.client || '거래처 모름'}</span>
              <span>{fmtDay(ev.date)}</span>
              <b>{won(ev.total || sum)}</b>
            </div>
          </section>
        )}

        {phase === 'added' && added && !other && (
          <div className="efas-choice">
            {added.members.map((o) => (
              <button key={o.id} type="button" className="efas-opt" onClick={() => memberSave(o)}>
                <div className="efas-opt-thumb">
                  <FitWorksheet pdfUrl={o.worksheetPdfUrl} thumbUrl={o.worksheetThumbnailUrl} title={o.title} />
                </div>
                <b>{added.members.length > 1 ? orderNoCore(o.orderNumber) : '같은 지시서'}</b>
                <span>{added.members.length > 1 ? o.title || '이 명세서에 든 지시서' : orderNoCore(o.orderNumber)}</span>
              </button>
            ))}
            <button type="button" className="efas-opt other" onClick={() => setOther(true)}>
              <div className="efas-opt-plus" aria-hidden="true">
                ＋
              </div>
              <b>다른 지시서</b>
              <span>골라서 함께 반영</span>
            </button>
          </div>
        )}

        {choosing && (
          <section className="efas-pick">
            <div className="efas-tools">
              <span className="efas-hint">
                {phase === 'confirm' ? (
                  '같은 지시서면 그대로 반영하고, 이 명세서를 같이 쓰는 지시서가 있으면 더 골라 묶어요'
                ) : phase === 'pick' ? (
                  '여러 지시서가 같이 쓰는 명세서면 여러 개 골라 묶어요'
                ) : phase === 'added' && added ? (
                  <>
                    <b>{added.base.clientCompanyName || '같은 거래처'}</b> 지시서 · 명세서 날짜와 가까운 순
                  </>
                ) : phase === 'added' || !clientKnown ? (
                  '비슷한 날짜 지시서'
                ) : (
                  <>
                    <b>{ev.client}</b> 지시서
                  </>
                )}
              </span>
              <input
                className="efas-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="거래처·주문번호 찾기"
                aria-label="거래처나 주문번호로 지시서 찾기"
              />
            </div>
            {cands === null ? (
              <p className="efas-empty">지시서를 찾는 중…</p>
            ) : visible.length || (phase === 'confirm' && linked?.length) ? (
              // 명세서 탭(관리자 주문 목록) 카드와 같은 모양 — 눈에 익어 고르기 쉽게(사용자 2026-11-24).
              // FS·폴더·공유·명세서 버튼은 없이 카드만. 누르면 고르고(파란 테두리), 아래 [반영하기].
              <div className="order-card-grid efas-cards">
                {phase === 'confirm' && (linked || []).map((o) => card(o, true))}
                {visible.slice(0, 24).map(({ o }) => card(o))}
              </div>
            ) : (
              <p className="efas-empty">
                {q ? '찾는 지시서가 없어요.' : phase === 'added' ? '같은 거래처 지시서가 없어요.' : '지시서가 없어요.'}
              </p>
            )}
            {phase === 'added' ? (
              <div className="efas-wider">
                {clientDays < 120 && (
                  <button type="button" onClick={() => setClientDays(120)}>
                    날짜 넓혀 보기
                  </button>
                )}
              </div>
            ) : (
              <div className="efas-wider">
                {!q && hiddenCount > 0 && (
                  <button type="button" onClick={() => setShowAll(true)}>
                    다른 거래처도 보기
                  </button>
                )}
                {days < 30 && (
                  <button type="button" onClick={() => setDays(30)}>
                    날짜 넓혀 보기
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {(phase === 'done' || phase === 'error') && (
          <section className={'efas-result ' + phase}>
            <p className="efas-result-main">
              {phase === 'done' ? '✅ ' : '⚠ '}
              {msg.main}
            </p>
            {msg.sub && <p className="efas-result-sub">{msg.sub}</p>}
            {msg.warn && <p className="efas-result-warn">{msg.warn}</p>}
            {(phase === 'error' || msg.warn) && !isExpectedMiss(msg.main, msg.sub, msg.warn) && (
              <div className="efas-failcopy">
                <FailCopyButton title={`이지폼 저장 반영 — ${msg.main}`} msg={[msg.sub, msg.warn].filter(Boolean).join(' / ')} />
                <span>{FAIL_COPY_GUIDE}</span>
              </div>
            )}
          </section>
        )}

        {busy && <div className="efas-busy">{phase === 'check' ? '확인하는 중…' : '반영하는 중…'}</div>}

        <footer className="efas-foot">
          {phase === 'assign' && assign ? (
            <>
              <button
                type="button"
                className="efas-btn ghost"
                onClick={() => (assign.step > 0 ? setAssign({ ...assign, step: assign.step - 1 }) : setPhase(ev.nos.length ? 'confirm' : 'pick'))}
              >
                ← {assign.step > 0 ? '이전 지시서' : '지시서 다시 고르기'}
              </button>
              <button type="button" className="efas-btn primary" disabled={countOf(assign.step) === 0} onClick={assignNext}>
                {countOf(assign.step) === 0
                  ? '줄을 골라주세요'
                  : assign.step < assign.orders.length - 1
                    ? '다음 지시서 →'
                    : assignDone
                      ? `지시서 ${assign.orders.length}개 묶어서 반영`
                      : '안 고른 지시서로'}
              </button>
            </>
          ) : phase === 'added' && !other ? (
            <button type="button" className="efas-btn ghost" onClick={onClose}>
              반영 안 함
            </button>
          ) : choosing ? (
            <>
              {phase === 'added' ? (
                <button
                  type="button"
                  className="efas-btn ghost"
                  onClick={() => {
                    setOther(false);
                    setPicked(null);
                    setShowAll(false);
                  }}
                >
                  ← 뒤로
                </button>
              ) : (
                <button type="button" className="efas-btn ghost" onClick={onClose}>
                  반영 안 함
                </button>
              )}
              {phase === 'confirm' ? (
                <button type="button" className="efas-btn primary" disabled={linked === null} onClick={confirm}>
                  {linked === null ? '지시서 확인 중…' : extra.length ? `지시서 ${ev.nos.length + extra.length}개 묶어서 반영` : '이 지시서가 맞아요'}
                </button>
              ) : phase === 'pick' ? (
                <button type="button" className="efas-btn primary" disabled={!extra.length} onClick={confirm}>
                  {!extra.length ? '지시서를 골라주세요' : extra.length > 1 ? `지시서 ${extra.length}개 묶어서 반영` : '반영하기'}
                </button>
              ) : (
                <button type="button" className="efas-btn primary" disabled={!picked} onClick={confirm}>
                  {picked ? '반영하기' : '지시서를 골라주세요'}
                </button>
              )}
            </>
          ) : (
            <>
              {phase === 'error' && (cands?.length || 0) > 0 && (
                <button type="button" className="efas-btn ghost" onClick={() => setPhase(added ? 'added' : ev.nos.length ? 'confirm' : 'pick')}>
                  다시 고르기
                </button>
              )}
              <button
                type="button"
                className="efas-btn primary"
                onClick={onClose}
                disabled={phase === 'saving'}
                autoFocus={phase === 'done'}
                key={phase}
              >
                {phase === 'done' ? '확인 (이지폼으로 돌아가기)' : '확인'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
      {ask && (
        // 이 지시서가 맞나요? — 반영 직전 한 번 더 확인
        <div className="efas-ask" role="alertdialog" aria-modal="true" aria-label="이 지시서가 맞나요?">
          <div className="efas-ask-card">
            <h3>이 지시서가 맞나요?</h3>
            <div className="efas-ask-thumb">
              <FitWorksheet pdfUrl={ask.o.worksheetPdfUrl} thumbUrl={ask.o.worksheetThumbnailUrl} title={ask.o.title} />
            </div>
            <p className="efas-ask-name">
              <b>{orderNoCore(ask.o.orderNumber)}</b>
              {ask.o.clientCompanyName ? ` · ${ask.o.clientCompanyName}` : ''}
            </p>
            {ask.o.title && <p className="efas-ask-sub">{ask.o.title}</p>}
            {added && <p className="efas-ask-sub">추가한 {added.count}줄을 이 지시서로 홈페이지에 반영해요.</p>}
            {/* 왼쪽 = 예(초록), 오른쪽 = 아니요(회색) — 사용자 결정 2026-11-20 */}
            <div className="efas-ask-foot">
              <button
                type="button"
                className="efas-ask-yes"
                autoFocus
                onClick={() => {
                  const run = ask.run;
                  setAsk(null);
                  run();
                }}
              >
                예, 반영할게요
              </button>
              <button type="button" className="efas-ask-no" onClick={() => setAsk(null)}>
                아니요
              </button>
            </div>
          </div>
        </div>
      )}
      {zoom && (
        // 🔍 지시서 크게 보기 — 휠 확대·끌어 이동(작업중 탭과 같은 PDF 보기). 사진만 있으면 사진.
        <div className="efas-zoom" role="dialog" aria-modal="true" aria-label="지시서 크게 보기">
          <div className="efas-zoom-head">
            <b>
              {zoom.clientCompanyName || ''} · {orderNoCore(zoom.orderNumber)}
            </b>
            <button type="button" className="efas-x light" onClick={() => setZoom(null)} aria-label="닫기">
              ✕
            </button>
          </div>
          <div className="efas-zoom-body">
            {zoom.worksheetPdfUrl ? (
              <PdfViewer key={zoom.worksheetPdfUrl} url={zoom.worksheetPdfUrl} />
            ) : (
              <FitWorksheet pdfUrl={null} thumbUrl={zoom.worksheetThumbnailUrl} title={zoom.title} />
            )}
          </div>
          <div className="efas-zoom-foot">
            <button type="button" className="efas-btn ghost" onClick={() => setZoom(null)}>
              닫기
            </button>
            <button
              type="button"
              className="efas-btn primary"
              onClick={() => {
                if (phase === 'assign') {
                  /* 시작 줄 고르기 중엔 보기만 */
                } else if (phase === 'added') setPicked(zoom);
                else if (!extra.some((x) => x.id === zoom.id) && !ev.nos.includes(orderNoCore(zoom.orderNumber))) toggle(zoom);
                setZoom(null);
              }}
            >
              이 지시서 고르기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
