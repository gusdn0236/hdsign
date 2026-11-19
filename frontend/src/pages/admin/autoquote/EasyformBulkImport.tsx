/**
 * 명세서 탭 [📥 이지폼에서 가져오기] — 홈페이지엔 비어 있지만 이지폼엔 작성된 명세서를 찾아 한꺼번에 채운다.
 *
 * 흐름: ① 비어 있는 지시서들을 가운데 가로로 나열 → "총 n개 명세서를 이지폼에서 찾아볼게요" [확인]
 *       ② 워처가 이지폼 2개(주식회사·개인)에서 목록 엑셀을 뽑음 → 웹이 짝지음(efMatch)
 *       ③ 워처가 짝지어진 명세서만 열어 읽음 → 지시서 아래에 화살표로 하나씩 나타남
 *       ④ 명세서를 눌러 지시서와 나란히 보고 [맞아요]/[아니에요] → 체크
 *       ⑤ [n건 저장] → 홈페이지 명세서에 일괄 입력(이지폼은 안 건드림)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Document, Page } from 'react-pdf';
import WorksheetThumbnailJs from '../../../components/common/WorksheetThumbnail.jsx';
import {
  startEfBulk,
  pollEfBulk,
  cancelEfBulk,
  pauseEfBulk,
  probeEasyformAgent,
  extractOrderNos,
  orderNoCore,
  type EfListRow,
  type EfBulkResult,
} from './data/easyformClient';
import {
  matchOrders,
  efRowsToGrid,
  rememberClientAlias,
  candidatesToRead,
  rescoreByContent,
  markMerged,
  cellMatches,
  worksheetDims,
  type EfMatch,
  type EfCandidate,
  type EfOrder,
} from './data/efMatch';
import { BASE_URL, getEasyformUsedKeys, syncEstimateFromEasyform, findEasyformMatch } from './annot/api';
import './EasyformBulkImport.css';

// JS(memo) 컴포넌트라 props 타입이 추론되지 않음 → 느슨하게.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WorksheetThumbnail = WorksheetThumbnailJs as unknown as ComponentType<any>;

export interface EfBulkOrder extends EfOrder {
  worksheetPdfUrl?: string | null;
  worksheetThumbnailUrl?: string | null;
}

interface Props {
  orders: EfBulkOrder[];
  token: string | null | undefined;
  onClose: () => void;
  onSaved: (orderId: number) => void;
  /** 지시서 1건(명세서 상세카드)에서 연 경우 — 선택 화면 없이 바로 키워드 입력 화면, 키워드 없이 찾기 = 바로 찾기 */
  single?: boolean;
}

type Phase = 'intro' | 'clue' | 'export' | 'read' | 'review' | 'saving' | 'saved';
type Verdict = 'yes' | 'no';

const won = (s: string | number | undefined) => {
  const n = Number(String(s ?? '').replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) && String(s ?? '').replace(/[^0-9]/g, '') ? n.toLocaleString('ko-KR') : String(s ?? '');
};
const shortDate = (s?: string | null) => {
  const m = String(s || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  return m ? `${+m[2]}/${+m[3]}` : '';
};
const bizLabel = (b?: string) => (b === 'corp' ? '주식회사' : '개인');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dateOf = (o: EfBulkOrder) => new Date(o.dueDate || o.createdAt || 0).getTime();
const byDate = (a: EfBulkOrder, b: EfBulkOrder) => dateOf(a) - dateOf(b) || a.id - b.id;
const etaText = (sec: number) => (sec < 60 ? `약 ${Math.max(5, Math.round(sec / 5) * 5)}초 남음` : `약 ${Math.round(sec / 60)}분 남음`);
const SEC_PER_READ = 6; // 첫 결과 전 추정(실측 6건 38초)

export default function EasyformBulkImport({ orders: ordersProp, token, onClose, onSaved, single = false }: Props) {
  // 열 때의 목록으로 고정 — 저장하면서 부모 목록이 줄어들어도 화면이 흔들리지 않게.
  // 오래된 날짜순. 찾고 나면 '찾은 것 먼저(왼쪽) → 각각 오래된 날짜순'으로 다시 줄 세운다.
  const [orders, setOrders] = useState(() => [...ordersProp].sort(byDate));
  const [eta, setEta] = useState('');
  const [pauseWanted, setPauseWanted] = useState(false);
  const [pausedNow, setPausedNow] = useState(false);
  const [phase, setPhase] = useState<Phase>(single ? 'clue' : 'intro');
  const [pos, setPos] = useState(0);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<Record<number, EfMatch>>({});
  const [reads, setReads] = useState<Record<string, EfBulkResult>>({});
  const [verdict, setVerdict] = useState<Record<number, Verdict>>({});
  const [detail, setDetail] = useState<number | null>(null); // 열린 비교창의 주문 id
  const [swapping, setSwapping] = useState('');
  // 중간 저장 — 확인하다가 체크한 것만 먼저 저장(화면은 그대로, 계속 확인 가능). 저장한 주문은 다시 안 저장.
  const [savedIds, setSavedIds] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: number; fail: { order: EfBulkOrder; msg: string }[] } | null>(null);
  const [closeAsk, setCloseAsk] = useState(false);
  // 지금 이지폼에서 찾는 중인 지시서 — 화면이 그 카드로 따라간다(사람이 방금 넘겨 봤으면 4초간 안 따라감)
  const [searchingId, setSearchingId] = useState<number | null>(null);
  const manualAt = useRef(0);
  // 같은 이지폼 명세서를 다른 지시서도 쓸 때(다른 지시서에서 [맞아요] 했거나 홈페이지에 이미 저장됨) — 합칠지 묻는다.
  // merge = 합친 명세서로 묶어 저장, separate = 이 지시서에만 따로.
  const [mergeChoice, setMergeChoice] = useState<Record<number, 'merge' | 'separate'>>({});
  const [mergeAsk, setMergeAsk] = useState<{ orderId: number; nos: string[]; loading: boolean; others: number[] } | null>(null);
  // 사람이 넣은 단서(키워드·사이즈) — 지시서별. 넣은 지시서는 단서로 가려내고, 안 넣은 건 지금 방식대로.
  const [cluesState, setClues] = useState<Record<number, string[]>>({});
  const clues = cluesState;
  const jobRef = useRef<{ id: number; stop: boolean } | null>(null);
  const matchRef = useRef<Record<number, EfMatch>>({});
  const cluesRef = useRef<Record<number, string[]>>({});
  const readsRef = useRef<Record<string, EfBulkResult>>({});
  const dimsRef = useRef<Record<number, number[] | undefined>>({});
  const dimsWait = useRef<Promise<void>>(Promise.resolve());
  const phaseRef = useRef<Phase>('intro');
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1200);
  const [viewH, setViewH] = useState(700);

  const busy = phase === 'export' || phase === 'read' || phase === 'saving' || !!swapping;
  phaseRef.current = phase;
  cluesRef.current = clues;
  const n = orders.length;

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    setViewW(el.clientWidth);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [phase === 'clue']); // 단서 입력 화면에서 돌아오면 무대가 새로 붙음 → 다시 잰다

  useEffect(
    () => () => {
      if (jobRef.current) {
        jobRef.current.stop = true;
        cancelEfBulk(jobRef.current.id);
      }
    },
    [],
  );

  const go = useCallback(
    (d: number) => {
      manualAt.current = Date.now();
      setPos((p) => Math.max(0, Math.min(n - 1, p + d)));
    },
    [n],
  );
  // 키워드 넣은 지시서 맨 앞 → 오래된 날짜순 (키워드 입력을 마치고 나올 때·찾기 시작할 때 다시 세움)
  const sortKwFirst = (list: EfBulkOrder[], cl: Record<number, string[]>) =>
    [...list].sort((a, b) => Number(!cl[a.id]?.length) - Number(!cl[b.id]?.length) || byDate(a, b));
  // 비교창 — 다음·이전 지시서를 미리 받아 둬서 넘기자마자 뜨게
  useEffect(() => {
    if (detail == null) return;
    const i = orders.findIndex((o) => o.id === detail);
    prefetchWorksheets([orders[i + 1], orders[i + 2], orders[i - 1]]);
  }, [detail, orders]);

  // 워처 작업 하나를 끝날 때까지 폴링. onTick 으로 중간 결과(읽은 명세서)를 바로 반영.
  const runJob = async (body: Parameters<typeof startEfBulk>[0], onTick?: (s: Awaited<ReturnType<typeof pollEfBulk>>) => void) => {
    const r = await startEfBulk(body);
    if (!r.started || !r.id) throw new Error(r.message || '이지폼 작업을 시작하지 못했어요.');
    const job = { id: r.id, stop: false };
    jobRef.current = job;
    for (;;) {
      await sleep(600);
      if (job.stop) throw new Error('취소했어요.');
      const s = await pollEfBulk(job.id);
      onTick?.(s);
      setPausedNow(!!s.paused);
      if (s.progress) setProgress(s.progress);
      if (s.state === 'gone') throw new Error('워처가 다시 시작돼서 작업이 끊겼어요.');
      if (s.state !== 'running') {
        jobRef.current = null;
        if (s.state === 'error') throw Object.assign(new Error(s.message || '이지폼 작업이 멈췄어요.'), { status: s });
        return s;
      }
    }
  };

  const applyResults = (rs?: EfBulkResult[]) => {
    if (!rs?.length) return;
    rs.forEach((x) => (readsRef.current[x.key] = x));
    setReads((prev) => {
      const next = { ...prev };
      rs.forEach((x) => (next[x.key] = x));
      return next;
    });
  };

  // cluesArg = 키워드 화면에서 칸에 쳐 두고 Enter 안 누른 글자까지 합친 키워드(상태 반영 전이라 직접 넘김)
  const start = async (cluesArg?: Record<number, string[]>) => {
    const clues = cluesArg ?? cluesState;
    if (cluesArg) setClues(cluesArg);
    setError('');
    const probe = await probeEasyformAgent();
    if (!probe?.easyform) {
      setError('이 PC 에서 워처가 꺼져 있거나 이지폼 자동화를 쓸 수 없어요. 워처를 켜고 다시 해주세요.');
      return;
    }
    setOrders((prev) => sortKwFirst(prev, clues));
    setPos(0);
    setPhase('export');
    setProgress('이지폼에서 명세서 목록을 뽑고 있어요');
    try {
      const [used, exp] = await Promise.all([getEasyformUsedKeys(token), runJob({ phase: 'export' })]);
      const rows: EfListRow[] = (exp.lists || []).flatMap((l) => l.rows);
      const ms = matchOrders(orders, rows, used, clues);
      const map: Record<number, EfMatch> = {};
      ms.forEach((m) => (map[m.order.id] = m));
      matchRef.current = map;
      setMatches(map);
      // 카드 순서 = 키워드 넣은 지시서 먼저 → 짝 찾은 지시서 → 각각 오래된 날짜순. 이지폼 순회도 이 순서 그대로.
      const kwFirst = (o: EfBulkOrder) => (clues[o.id]?.length ? 0 : 1);
      const sorted = [...orders].sort(
        (a, b) => kwFirst(a) - kwFirst(b) || Number(!!map[b.id]?.best) - Number(!!map[a.id]?.best) || byDate(a, b),
      );
      setOrders(sorted);
      setPos(0);
      const msSorted = sorted.map((o) => map[o.id]).filter(Boolean);
      // 헷갈리는 지시서(같은 거래처·비슷한 점수 후보)는 후보를 최대 3개 같이 읽는다 → 지시서 수치로 다시 매김
      // 읽기 순서: ① 키워드 넣은 지시서의 후보 먼저 → ② 키워드 없는 지시서(사용자가 ①까지 보고 정지·저장할 수 있게)
      const seen = new Set<string>();
      const owner: string[] = []; // items 순서대로 그 후보를 읽는 지시서 id(화면 따라가기용)
      const ownerId: number[] = [];
      const pick = (list: EfMatch[]) =>
        list.flatMap((m) =>
          candidatesToRead(m, !!clues[m.order.id]?.length)
            .filter((c) => !seen.has(c.key) && seen.add(c.key))
            .map((c) => {
              owner.push(c.key);
              ownerId.push(m.order.id);
              return { ...c.row, key: c.key };
            }),
        );
      const kwItems = pick(msSorted.filter((m) => clues[m.order.id]?.length));
      const restItems = pick(msSorted.filter((m) => !clues[m.order.id]?.length));
      const items = [...kwItems, ...restItems];
      // 다음에 읽을 후보의 지시서로 화면을 넘긴다(사람이 방금 직접 넘겨 봤으면 잠깐 안 따라감)
      const follow = (doneN: number) => {
        const id = ownerId[Math.min(doneN, ownerId.length - 1)];
        if (id == null) return;
        setSearchingId(doneN >= ownerId.length ? null : id);
        if (Date.now() - manualAt.current < 4000) return;
        const i = sorted.findIndex((o) => o.id === id);
        if (i >= 0) setPos(i);
      };
      follow(0);
      dimsWait.current = loadDims(
        ms.filter((m) => candidatesToRead(m, !!clues[m.order.id]?.length).length > 1).map((m) => m.order as EfBulkOrder),
      );
      if (!items.length) {
        setPhase('review');
        setProgress('');
        return;
      }
      setPhase('read');
      setProgress(`후보 명세서 ${items.length}건을 이지폼에서 읽고 있어요`);
      setEta(etaText(items.length * SEC_PER_READ));
      // 남은 시간 — 지금까지 1건당 걸린 시간(일시정지 시간 뺌) × 남은 건수(두 단계 합쳐서)
      const t0 = Date.now();
      let pausedMs = 0;
      let lastTick = t0;
      let doneBefore = 0;
      const tick = (s: Awaited<ReturnType<typeof pollEfBulk>>) => {
        applyResults(s.results);
        const now = Date.now();
        if (s.paused) pausedMs += now - lastTick;
        lastTick = now;
        const done = doneBefore + (s.results?.length || 0);
        const per = done ? (now - t0 - pausedMs) / 1000 / done : SEC_PER_READ;
        setEta(s.paused ? '' : etaText(per * (items.length - done)));
        follow(done);
      };
      if (kwItems.length) {
        const f1 = await runJob({ phase: 'read', items: kwItems, keepOrder: true }, tick);
        applyResults(f1.results);
        doneBefore = kwItems.length;
        // 키워드 지시서는 여기서 바로 최종 순위 — 사용자가 이걸 보고 정지·저장해도 되게
        await dimsWait.current;
        rescoreNow();
        if (restItems.length) setProgress(`키워드 넣은 지시서는 다 찾았어요 · 나머지 ${restItems.length}건 읽는 중`);
      }
      if (restItems.length) {
        const f2 = await runJob({ phase: 'read', items: restItems, keepOrder: true }, tick);
        applyResults(f2.results);
      }
      await dimsWait.current;
      finishRead();
    } catch (e) {
      const st = (e as { status?: { results?: EfBulkResult[] } }).status;
      applyResults(st?.results);
      setError((e as Error).message);
      // 읽다가 멈췄어도 읽은 것까지는 확인할 수 있게 review 로.
      if (phaseRef.current === 'read') {
        await dimsWait.current;
        finishRead(st?.results);
      }
      else setPhase(single ? 'clue' : 'intro');
      setProgress('');
    } finally {
      setEta('');
      setSearchingId(null);
      setPauseWanted(false);
      setPausedNow(false);
    }
  };

  // 지시서 수치(도형 가로·세로 mm) — 지시서 올릴 때 같이 올라간 데이터. 헷갈리는 지시서만, 6개씩 나눠 받는다.
  const loadDims = async (list: EfBulkOrder[]) => {
    const q = [...list];
    const worker = async () => {
      for (let o = q.shift(); o; o = q.shift()) {
        if (!o.orderNumber || dimsRef.current[o.id] !== undefined) continue;
        try {
          const r = await fetch(`${BASE_URL}/api/public/worksheets/${encodeURIComponent(o.orderNumber)}/objects`);
          dimsRef.current[o.id] = r.ok ? worksheetDims(await r.json()) : [];
        } catch {
          dimsRef.current[o.id] = [];
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  };

  // 읽기 끝 — 읽은 명세서 내용(규격↔지시서 수치, 비고 주문번호)으로 짝을 다시 정하고,
  // 짝 찾은 지시서를 왼쪽부터(각각 오래된 날짜순) 다시 세워 확인 단계로.
  // 지금까지 읽은 것으로 다시 매기기(읽는 중에도) — 키워드 지시서 1단계가 끝났을 때
  const rescoreNow = () => {
    const map = rescoreByContent(matchRef.current, readsRef.current, dimsRef.current, cluesRef.current);
    matchRef.current = map;
    setMatches(map);
  };

  const finishRead = (rs?: EfBulkResult[]) => {
    (rs || []).forEach((x) => (readsRef.current[x.key] = x));
    const map = rescoreByContent(matchRef.current, readsRef.current, dimsRef.current, cluesRef.current);
    matchRef.current = map;
    setMatches(map);
    const ok = new Set(Object.values(readsRef.current).filter((x) => x.ok).map((x) => x.key));
    const rank = (o: EfBulkOrder) => (map[o.id]?.best && ok.has(map[o.id].best!.key) ? 0 : map[o.id]?.best ? 1 : 2);
    const kw = (o: EfBulkOrder) => (cluesRef.current[o.id]?.length ? 0 : 1); // 키워드 넣은 지시서가 맨 왼쪽
    setOrders((prev) => [...prev].sort((a, b) => kw(a) - kw(b) || rank(a) - rank(b) || byDate(a, b)));
    setPos(0);
    setPhase('review');
    setProgress('');
  };

  // [정지] — 워처가 지금 명세서까지 닫고 멈춘다(폴링이 끝을 받아 읽은 것까지 확인 단계로).
  const cancel = () => {
    if (jobRef.current) cancelEfBulk(jobRef.current.id);
    setPauseWanted(false);
    setProgress('지금 읽던 명세서까지 닫고 멈추는 중…');
  };
  // [일시정지]/[계속] — 명세서를 다 닫고 다음 건으로 넘어가는 자리에서 선다.
  const togglePause = () => {
    if (!jobRef.current) return;
    const on = !pauseWanted;
    setPauseWanted(on);
    pauseEfBulk(jobRef.current.id, on);
    if (!on) setPausedNow(false);
  };

  // 다른 후보로 바꾸기 — 그 1건만 워처가 열어 읽고, 이 지시서의 짝으로 바꾼다(다른 지시서 짝이었으면 거기선 뺌).
  const pickCandidate = async (orderId: number, c: EfCandidate) => {
    setSwapping(c.key);
    setError('');
    try {
      if (!reads[c.key]?.ok) {
        const fin = await runJob({ phase: 'read', items: [{ ...c.row, key: c.key }] });
        applyResults(fin.results);
        if (!fin.results?.find((x) => x.key === c.key)?.ok) throw new Error(fin.results?.[0]?.message || '그 명세서를 읽지 못했어요.');
      }
      setMatches((prev) => {
        const next = { ...prev };
        // 다른 지시서가 쓰는 명세서 — 같은 거래처·납기 ±1일이면 빼앗지 않고 같이 쓰기(합친 명세서), 아니면 가져옴
        const share = c.client >= 0.85 && c.days <= 1;
        Object.values(next).forEach((m) => {
          if (m.order.id !== orderId && m.best?.key === c.key && !share) {
            next[m.order.id] = { ...m, best: null, others: [c, ...m.others] };
          }
        });
        const me = next[orderId];
        const old = me.best;
        next[orderId] = { ...me, best: c, others: [...(old ? [old] : []), ...me.others.filter((x) => x.key !== c.key)], sure: false };
        for (const m of markMerged(Object.values(next))) next[m.order.id] = m;
        matchRef.current = next;
        return next;
      });
      setVerdict((v) => {
        const nv = { ...v };
        delete nv[orderId];
        return nv;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwapping('');
    }
  };

  // 이 지시서의 명세서를 같이 쓰는 다른 주문 — 이번에 [맞아요] 한 지시서 + 홈페이지에 이미 저장된 주문
  const sharersOf = (orderId: number) => {
    const key = matches[orderId]?.best?.key;
    if (!key) return { session: [] as EfBulkOrder[], saved: false };
    const session = orders.filter(
      (o) => o.id !== orderId && matches[o.id]?.best?.key === key && (verdict[o.id] === 'yes' || savedIds.has(o.id)),
    );
    return { session, saved: !!matches[orderId].best!.usedBy?.length };
  };
  const mark = (orderId: number, v: Verdict, choice?: 'merge' | 'separate') => {
    if (v === 'yes' && !choice && !mergeChoice[orderId]) {
      const sh = sharersOf(orderId);
      if (sh.session.length || sh.saved) {
        const nos = sh.session.map((o) => orderNoCore(o.orderNumber));
        setMergeAsk({ orderId, nos, loading: sh.saved, others: sh.session.map((o) => o.id) });
        if (sh.saved) {
          const m = matches[orderId];
          const rd = reads[m.best!.key];
          findEasyformMatch(token, orderId, rd?.date || m.best!.row.date, rd?.total || m.best!.row.total).then((gs) => {
            const more = gs.flatMap((g) => g.orders.map((o) => orderNoCore(o.orderNumber)));
            setMergeAsk((a) => (a && a.orderId === orderId ? { ...a, nos: [...new Set([...a.nos, ...more])], loading: false } : a));
          });
        }
        return;
      }
    }
    if (choice) setMergeChoice((prev) => ({ ...prev, [orderId]: choice }));
    setVerdict((prev) => ({ ...prev, [orderId]: v }));
    // 다음 아직 안 본(읽힌 명세서가 있는) 지시서로 이동
    const idx = orders.findIndex((o) => o.id === orderId);
    for (let k = 1; k <= n; k++) {
      const o = orders[(idx + k) % n];
      const m = matches[o.id];
      const rd = m?.best ? reads[m.best.key] : null;
      if (rd?.ok && !verdict[o.id] && o.id !== orderId) {
        setPos((idx + k) % n);
        setDetail(o.id);
        return;
      }
    }
    setDetail(null);
  };

  const yesList = orders.filter(
    (o) => verdict[o.id] === 'yes' && !savedIds.has(o.id) && matches[o.id]?.best && reads[matches[o.id].best!.key]?.ok,
  );

  const save = async () => {
    if (saving || !yesList.length) return;
    setSaving(true);
    setError('');
    let ok = 0;
    const fail: { order: EfBulkOrder; msg: string }[] = [];
    // 같은 이지폼 명세서를 [맞아요] 한 지시서끼리 묶는다 → 합친 명세서 1장(대표 = 납기 빠른 주문), 매출은 한 번만.
    // '따로'를 고른 지시서는 혼자, 나머지는 같은 명세서끼리 묶는다.
    const groups = new Map<string, EfBulkOrder[]>();
    for (const o of [...yesList].sort(byDate)) {
      const k = mergeChoice[o.id] === 'separate' ? `solo:${o.id}` : matches[o.id].best!.key;
      groups.set(k, [...(groups.get(k) || []), o]);
    }
    const queue = [...groups.values()];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        const m = matches[g[0].id];
        const rd = reads[m.best!.key];
        try {
          const grid = efRowsToGrid(rd.rows || []);
          const sum = grid.reduce((a, x) => a + (Number(x.공급가액) || 0), 0);
          const efDate = rd.date || m.best!.row.date;
          const efTotal = rd.total || m.best!.row.total;
          // '합친 명세서로 묶기'를 고른 지시서가 있으면, 이 명세서를 이미 쓰는 홈페이지 주문(앞서 저장한 것 포함)과 같이 묶는다.
          // 기존 묶음의 대표가 계속 대표(먼저), 매출은 한 번만.
          let existing: string[] = [];
          if (g.some((o) => mergeChoice[o.id] === 'merge')) {
            const gs = await findEasyformMatch(token, g[0].id, efDate, efTotal);
            existing = gs.flatMap((x) => x.orders.map((o) => orderNoCore(o.orderNumber)));
          }
          const nos = [...new Set([...existing, ...g.map((o) => orderNoCore(o.orderNumber))])];
          await syncEstimateFromEasyform(token, {
            orderNumbers: nos,
            grid,
            total: sum,
            source: 'batch',
            efDate,
            efTotal,
          });
          g.forEach((o) => {
            rememberClientAlias(o.clientCompanyName, m.best!.row.client);
            onSaved(o.id);
          });
          setSavedIds((prev) => new Set([...prev, ...g.map((o) => o.id)]));
          ok += g.length;
        } catch (e) {
          g.forEach((o) => fail.push({ order: o, msg: (e as Error).message }));
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    setSaveMsg({ ok, fail });
    setSaving(false);
  };

  // 닫기 — 저장 안 한 체크가 있거나 이지폼 작업 중이면 먼저 묻는다.
  const running = phase === 'export' || phase === 'read';
  const requestClose = () => {
    if (saving) return;
    if (yesList.length || running) setCloseAsk(true);
    else onClose();
  };
  const closeNow = async (withSave: boolean) => {
    setCloseAsk(false);
    if (withSave) await save();
    if (jobRef.current) cancelEfBulk(jobRef.current.id);
    onClose();
  };

  // 키보드 — ←/→ 넘기기, 비교창: Enter 맞아요 · X 아니에요 · Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (closeAsk) {
        if (e.key === 'Escape') setCloseAsk(false);
        return;
      }
      if (mergeAsk) {
        if (e.key === 'Escape') setMergeAsk(null);
        return;
      }
      if (phaseRef.current === 'clue') return;
      if (detail != null) {
        if (e.key === 'Escape') setDetail(null);
        else if (e.key === 'Enter' && !swapping) mark(detail, 'yes');
        else if ((e.key === 'x' || e.key === 'X' || e.key === 'Backspace') && !swapping) mark(detail, 'no');
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const idx = orders.findIndex((o) => o.id === detail);
          const ni = Math.max(0, Math.min(n - 1, idx + (e.key === 'ArrowLeft' ? -1 : 1)));
          setPos(ni);
          setDetail(orders[ni].id);
        } else return;
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Escape') requestClose();
      else if (e.key === 'Enter' && (phase === 'review' || phase === 'read')) {
        const o = orders[pos];
        const m = o && matches[o.id];
        if (m?.best && reads[m.best.key]?.ok) setDetail(o.id);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 마우스 휠로도 좌우 넘기기(살짝 모아서)
  const wheelAcc = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    wheelAcc.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(wheelAcc.current) > 80) {
      go(wheelAcc.current > 0 ? 1 : -1);
      wheelAcc.current = 0;
    }
  };

  const stats = useMemo(() => {
    let found = 0;
    let none = 0;
    orders.forEach((o) => {
      const m = matches[o.id];
      if (!m) return;
      if (m.best && reads[m.best.key]?.ok) found++;
      else if (!m.best) none++;
    });
    const yes = Object.values(verdict).filter((v) => v === 'yes').length;
    const no = Object.values(verdict).filter((v) => v === 'no').length;
    return { found, none, yes, no, left: Math.max(0, found - yes - no) };
  }, [orders, matches, reads, verdict]);

  // 지시서 카드 = 가운데 화면을 거의 채우게 — 무대 높이에서 아래 정보·화살표·명세서 카드 자리(~240px)를 빼고,
  // 폭은 화면의 62% 까지. 작은 화면에서도 300px 아래로는 안 줄인다.
  const CARD_W = Math.round(Math.max(300, Math.min(viewW * 0.62, viewH - 240)));
  const GAP = 34;
  const offset = viewW / 2 - CARD_W / 2 - pos * (CARD_W + GAP);
  const detailOrder = detail != null ? orders.find((o) => o.id === detail) : null;

  return (
    <div className="efb" role="dialog" aria-label="이지폼에서 가져오기">
      <header className="efb-top">
        <div className="efb-title">
          <span className="efb-title-icon" aria-hidden="true">📥</span>
          이지폼에서 가져오기
        </div>
        <ol className="efb-steps">
          {[
            ['지시서 확인', phase === 'intro'],
            ['이지폼에서 찾기', phase === 'export' || phase === 'read'],
            ['맞는지 확인', phase === 'review'],
            ['저장', saving],
          ].map(([label, on], i) => (
            <li key={i} className={on ? 'on' : ''}>
              <b>{i + 1}</b>
              {label}
            </li>
          ))}
        </ol>
        <button type="button" className="efb-x" onClick={requestClose} disabled={saving} title="닫기">
          ✕
        </button>
      </header>

      {(phase === 'export' || phase === 'read' || progress) && (
        <div className={`efb-progress ${pausedNow ? 'is-paused' : ''}`}>
          {pausedNow ? <span className="efb-pausedot" aria-hidden="true" /> : <span className="efb-spin" aria-hidden="true" />}
          <span>
            {pausedNow
              ? '일시정지됨 — [계속]을 누르면 이어서 해요'
              : pauseWanted
                ? '지금 명세서까지 읽고 일시정지해요…'
                : progress || '이지폼 작업 중'}
          </span>
          {eta && !pauseWanted && <span className="efb-eta">{eta}</span>}
          {(phase === 'export' || phase === 'read') && (
            <span className="efb-ctl">
              <button type="button" onClick={togglePause} className={pauseWanted ? 'is-on' : ''}>
                {pauseWanted ? '▶ 계속' : '❚❚ 일시정지'}
              </button>
              <button type="button" onClick={cancel} className="efb-ctl-stop">■ 정지</button>
            </span>
          )}
          <span className="efb-progress-hint">이지폼은 숨은 채로 작업해요 · 그동안 이지폼은 만지지 마세요</span>
        </div>
      )}
      {error && (
        <div className="efb-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')} aria-label="닫기">✕</button>
        </div>
      )}

      {phase === 'clue' ? (
        <ClueEntry
          orders={orders}
          pos={pos}
          setPos={setPos}
          clues={clues}
          setClues={setClues}
          onBack={() => {
            if (single) return requestClose(); // 1건 = 선택 화면 없음 → ESC 는 창 닫기
            setOrders((prev) => sortKwFirst(prev, clues));
            setPos(0);
            setPhase('intro');
          }}
          onStart={(c) => void start(c)}
          single={single}
        />
      ) : (
        <>
      <div className="efb-stage" ref={trackRef} onWheel={onWheel}>
        {n === 0 ? (
          <div className="efb-empty">명세서가 비어 있는 지시서가 없어요.</div>
        ) : (
          <>
            <div className="efb-track" style={{ transform: `translateX(${offset}px)` }}>
              {orders.map((o, i) => {
                const m = matches[o.id];
                const rd = m?.best ? reads[m.best.key] : undefined;
                const v = verdict[o.id];
                const dist = Math.abs(i - pos);
                const remarkNos = rd?.ok ? extractOrderNos((rd.rows || []).map((r) => r.remark || '').join(' ')) : [];
                const sure = remarkNos.includes(orderNoCore(o.orderNumber));
                let state: string;
                if (!m) state = phase === 'export' || phase === 'read' ? 'wait' : 'idle';
                else if (!m.best) state = 'none';
                else if (!rd) state = phase === 'read' ? 'wait' : 'unread';
                else state = rd.ok ? 'ok' : 'fail';
                return (
                  <div
                    key={o.id}
                    className={`efb-col ${i === pos ? 'is-active' : ''} ${v ? `is-${v}` : ''} ${savedIds.has(o.id) ? 'is-saved' : ''} ${phase === 'read' && searchingId === o.id ? 'is-searching' : ''}`}
                    style={{ width: CARD_W, marginRight: GAP, ...(dist > 4 ? { opacity: 0 } : {}) }}
                    onClick={() => {
                      manualAt.current = Date.now();
                      setPos(i);
                    }}
                  >
                    <div className="efb-ws">
                      <div className="efb-ws-thumb">
                        <WorksheetThumbnail
                          pdfUrl={o.worksheetPdfUrl || null}
                          thumbnailUrl={o.worksheetThumbnailUrl || null}
                          fallback={<div className="efb-ws-empty">{o.title || '지시서'}</div>}
                        />
                        {savedIds.has(o.id) ? (
                          <span className="efb-savedtag">저장됨</span>
                        ) : (
                          v && <span className={`efb-mark efb-mark--${v}`}>{v === 'yes' ? '✓' : '✕'}</span>
                        )}
                      </div>
                      <div className="efb-ws-meta">
                        <span className="efb-ws-date">{shortDate(o.dueDate || o.createdAt)}{o.dueDate ? ' 납' : ''}</span>
                        <span className="efb-ws-client">{o.clientCompanyName || '거래처 없음'}</span>
                      </div>
                      <div className="efb-ws-title" title={o.title || ''}>{o.title || orderNoCore(o.orderNumber)}</div>
                      {clues[o.id]?.length ? <div className="efb-ws-clues">키워드 · {clues[o.id].join(', ')}</div> : null}
                    </div>

                    {state !== 'idle' && <div className={`efb-arrow efb-arrow--${state}`} aria-hidden="true" />}

                    {state === 'wait' && <div className="efb-ef efb-ef--wait"><span className="efb-shimmer" />이지폼에서 찾는 중…</div>}
                    {state === 'none' && <div className="efb-ef efb-ef--none">비슷한 명세서를<br />이지폼에서 못 찾았어요</div>}
                    {state === 'unread' && <div className="efb-ef efb-ef--none">읽지 못했어요<br /><small>(작업이 중간에 멈춤)</small></div>}
                    {state === 'fail' && <div className="efb-ef efb-ef--none">{rd?.message || '읽지 못했어요'}</div>}
                    {state === 'ok' && m?.best && (
                      <button
                        type="button"
                        className={`efb-ef efb-ef--ok ${v ? `is-${v}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPos(i);
                          setDetail(o.id);
                        }}
                        title="눌러서 지시서와 나란히 보기"
                      >
                        <span className="efb-ef-top">
                          <span className={`efb-biz efb-biz--${m.best.row.biz}`}>{bizLabel(m.best.row.biz)}</span>
                          <span className="efb-ef-date">{shortDate(rd.date || m.best.row.date)}</span>
                          {m.best.usedBy?.length && !m.mergedWith?.length ? (
                            <span className="efb-merged" title="이 명세서는 홈페이지의 다른 주문에 이미 저장돼 있어요 — 맞아요를 누르면 합칠지 물어봐요">
                              이미 저장된 명세서
                            </span>
                          ) : m.mergedWith?.length ? (
                            <span
                              className="efb-merged"
                              title={`이 명세서를 같이 쓰는 지시서: ${m.mergedWith
                                .map((id) => orderNoCore(orders.find((x) => x.id === id)?.orderNumber))
                                .join(', ')}`}
                            >
                              합친 명세서 +{m.mergedWith.length}
                            </span>
                          ) : sure ? (
                            <span className="efb-sure" title="이지폼 비고에 이 주문번호가 적혀 있어요">주문번호 ✓</span>
                          ) : phase === 'review' && m.others.some((c) => reads[c.key]?.ok) ? (
                            <span className="efb-alt" title="비슷한 명세서가 더 있어요 — 눌러서 비교해 보세요">
                              후보 {1 + m.others.filter((c) => reads[c.key]?.ok).length}개
                            </span>
                          ) : null}
                        </span>
                        <span className="efb-ef-client">{m.best.row.client}</span>
                        <span className="efb-ef-item">{m.best.row.firstItem || '—'}</span>
                        <span className="efb-ef-total">{won(rd.total || m.best.row.total)}원 · {(rd.rows || []).filter((r) => (r.item || r.unit_price || '').trim()).length}줄</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" className="efb-nav efb-nav--l" onClick={() => go(-1)} disabled={pos === 0} aria-label="이전">‹</button>
            <button type="button" className="efb-nav efb-nav--r" onClick={() => go(1)} disabled={pos >= n - 1} aria-label="다음">›</button>
          </>
        )}
      </div>

      {n > 5 && (
        <div className="efb-scrub-row">
          <input
            type="range"
            className="efb-scrub"
            min={0}
            max={n - 1}
            value={pos}
            onChange={(e) => {
              manualAt.current = Date.now();
              setPos(Number(e.target.value));
            }}
            aria-label="지시서 넘기기"
            style={{ ['--efb-p' as string]: `${n > 1 ? (pos / (n - 1)) * 100 : 0}%` }}
          />
        </div>
      )}

      <footer className="efb-foot">
        <div className="efb-count">
          <b>{n ? pos + 1 : 0}</b> / {n}
        </div>
        {phase === 'intro' && (() => {
          const hasClues = Object.keys(clues).length > 0;
          return (
          <div className="efb-cta">
            <p className="efb-lead">
              총 <b>{n}개</b> 명세서를 이지폼에서 찾아볼게요
            </p>
            <p className="efb-sub">
              주식회사·개인 이지폼 2개를 켜 두세요(최소화해도 돼요). 이지폼에 작성 중인 명세서 창이 열려 있으면 멈춰요.
            </p>
            <div className="efb-cta-btns">
              {/* 키워드 입력 = 색칠(주 버튼), 바로 찾기 = 색 없음. 키워드를 넣고 돌아오면 [찾기 시작]이 주 버튼. */}
              <button type="button" className={hasClues ? 'efb-secondary' : 'efb-primary'} onClick={() => setPhase('clue')} disabled={!n}>
                ✎ 키워드 입력하고 찾기
              </button>
              <button type="button" className={hasClues ? 'efb-primary' : 'efb-secondary'} onClick={() => void start()} disabled={!n}>
                {Object.keys(clues).length ? `찾기 시작 (키워드 ${Object.keys(clues).length}건)` : '바로 찾기'}
              </button>
            </div>
          </div>
          );
        })()}
        {phase === 'export' && (
          <div className="efb-cta">
            <p className="efb-lead">이지폼에서 찾고 있어요 · 찾은 명세서가 지시서 아래에 나타나요</p>
          </div>
        )}
        {(phase === 'read' || phase === 'review') && (
          <div className="efb-cta efb-cta--row">
            <div className="efb-tally">
              <span className="t-yes">맞음 <b>{stats.yes}</b></span>
              <span className="t-no">아님 <b>{stats.no}</b></span>
              <span className="t-left">남음 <b>{stats.left}</b></span>
              {savedIds.size > 0 && <span className="t-saved">저장됨 <b>{savedIds.size}</b></span>}
              {stats.none > 0 && <span className="t-none">못 찾음 {stats.none}</span>}
            </div>
            <p className="efb-sub">
              {saveMsg
                ? `${saveMsg.ok}건 저장했어요${saveMsg.fail.length ? ` · ${saveMsg.fail.length}건 실패` : ''} · 계속 확인할 수 있어요`
                : phase === 'read'
                  ? '읽힌 명세서부터 눌러서 확인할 수 있어요 · 체크한 것만 먼저 저장해도 돼요'
                  : '명세서를 눌러 지시서와 비교하세요 · ←/→ 넘기기 · 체크한 것만 먼저 저장해도 돼요'}
            </p>
            <button type="button" className="efb-primary" onClick={save} disabled={!yesList.length || saving}>
              {saving ? '저장하는 중…' : yesList.length ? `체크한 ${yesList.length}건 저장` : '맞는 명세서를 체크하세요'}
            </button>
          </div>
        )}
        {saveMsg && saveMsg.fail.length > 0 && (
          <ul className="efb-faillist efb-faillist--foot">
            {saveMsg.fail.map((f) => (
              <li key={f.order.id}>{orderNoCore(f.order.orderNumber)} {f.order.clientCompanyName} — {f.msg}</li>
            ))}
          </ul>
        )}
      </footer>
        </>
      )}

      {mergeAsk && (() => {
        const me = orders.find((o) => o.id === mergeAsk.orderId);
        const peers = mergeAsk.others.map((id) => orders.find((o) => o.id === id)).filter((o): o is EfBulkOrder => !!o);
        const savedNos = mergeAsk.nos.filter((no) => !peers.some((p) => orderNoCore(p.orderNumber) === no));
        const card = (o: EfBulkOrder | undefined, label: string) =>
          o ? (
            <div className="efb-merge-ws" key={o.id}>
              <div className="efb-merge-thumb">
                <WorksheetThumbnail pdfUrl={o.worksheetPdfUrl || null} thumbnailUrl={o.worksheetThumbnailUrl || null} />
              </div>
              <div className="efb-merge-cap">
                <b>{label}</b> {shortDate(o.dueDate || o.createdAt)}
                {o.dueDate ? ' 납' : ''} · {orderNoCore(o.orderNumber)}
              </div>
            </div>
          ) : null;
        const choose = (c: 'merge' | 'separate') => {
          const id = mergeAsk.orderId;
          setMergeAsk(null);
          mark(id, 'yes', c);
        };
        return (
          <div className="efb-ask" role="dialog" aria-label="두 지시서 합치기 확인" onClick={() => setMergeAsk(null)}>
            <div className="efb-askbox efb-askbox--wide" onClick={(e) => e.stopPropagation()}>
              <p className="efb-ask-title">같은 현장에 들어간 지시서인가요?</p>
              <p className="efb-ask-sub">
                이 이지폼 명세서를{' '}
                {peers.length ? '아래 지시서에서도 맞다고 했어요' : ''}
                {peers.length && (savedNos.length || mergeAsk.loading) ? ', ' : ''}
                {savedNos.length ? (
                  <>
                    <b>주문 {savedNos.join(', ')}</b>에 이미 등록돼 있어요
                  </>
                ) : mergeAsk.loading ? (
                  '다른 주문에 이미 등록돼 있어요 …'
                ) : (
                  ''
                )}
                .<br />
                같은 현장이라 명세서 한 장으로 끊은 거라면 <b>두 지시서를 합치세요</b> — 명세서 1장을 같이 쓰고 매출은 한 번만
                잡혀요.
              </p>
              <div className="efb-merge-row">
                {card(me, '이 지시서')}
                {peers.map((p) => card(p, '같은 명세서 지시서'))}
                {savedNos.map((no) => (
                  <div className="efb-merge-ws efb-merge-ws--saved" key={no}>
                    <div className="efb-merge-thumb efb-merge-thumb--empty">이미 등록됨</div>
                    <div className="efb-merge-cap">
                      <b>이미 등록된 지시서</b> · {no}
                    </div>
                  </div>
                ))}
              </div>
              <div className="efb-ask-btns">
                <button type="button" className="efb-ask-cancel" onClick={() => setMergeAsk(null)}>
                  취소
                </button>
                <button type="button" className="efb-ask-plain" onClick={() => choose('separate')}>
                  다른 현장 — 따로 두기
                </button>
                <button type="button" className="efb-primary" autoFocus onClick={() => choose('merge')}>
                  같은 현장 — 두 지시서 합치기
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {closeAsk && (
        <div className="efb-ask" role="dialog" aria-label="닫기 확인" onClick={() => setCloseAsk(false)}>
          <div className="efb-askbox" onClick={(e) => e.stopPropagation()}>
            <p className="efb-ask-title">
              {yesList.length ? `저장 안 한 체크가 ${yesList.length}건 있어요` : '이지폼에서 아직 찾는 중이에요'}
            </p>
            <p className="efb-ask-sub">
              {running ? '닫으면 이지폼 작업도 멈춰요(지금 읽던 명세서까지 닫고). ' : ''}
              {yesList.length ? '체크한 것만 홈페이지에 저장하고 닫을 수 있어요.' : ''}
            </p>
            <div className="efb-ask-btns">
              <button type="button" className="efb-ask-cancel" onClick={() => setCloseAsk(false)}>취소</button>
              <button type="button" className="efb-ask-plain" onClick={() => closeNow(false)}>
                {yesList.length ? '저장 안 하고 닫기' : '멈추고 닫기'}
              </button>
              {yesList.length > 0 && (
                <button type="button" className="efb-primary" onClick={() => closeNow(true)}>
                  {yesList.length}건 저장하고 닫기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {detailOrder && matches[detailOrder.id]?.best && (
        <DetailView
          order={detailOrder}
          match={matches[detailOrder.id]}
          read={reads[matches[detailOrder.id].best!.key]}
          reads={reads}
          verdict={verdict[detailOrder.id]}
          saved={savedIds.has(detailOrder.id)}
          keywords={clues[detailOrder.id] || []}
          dims={dimsRef.current[detailOrder.id]}
          index={orders.findIndex((o) => o.id === detailOrder.id)}
          total={n}
          swapping={swapping}
          onClose={() => setDetail(null)}
          onMark={(v) => mark(detailOrder.id, v)}
          onUse={(c) => pickCandidate(detailOrder.id, c)}
          mergedNos={(matches[detailOrder.id].mergedWith || []).map((id) => orderNoCore(orders.find((x) => x.id === id)?.orderNumber))}
          onNav={(d) => {
            const idx = orders.findIndex((o) => o.id === detailOrder.id);
            const ni = Math.max(0, Math.min(n - 1, idx + d));
            setPos(ni);
            setDetail(orders[ni].id);
          }}
        />
      )}
    </div>
  );
}

function DetailView({
  order,
  match,
  read,
  reads,
  verdict,
  index,
  total,
  swapping,
  onClose,
  onMark,
  onUse,
  onNav,
  mergedNos,
  saved,
  keywords,
  dims,
}: {
  order: EfBulkOrder;
  match: EfMatch;
  read?: EfBulkResult;
  reads: Record<string, EfBulkResult>;
  verdict?: Verdict;
  index: number;
  total: number;
  swapping: string;
  onClose: () => void;
  onMark: (v: Verdict) => void;
  onUse: (c: EfCandidate) => void;
  onNav: (d: number) => void;
  mergedNos: string[];
  saved: boolean;
  keywords: string[];
  dims?: number[];
}) {
  const best = match.best!;
  const rows = (read?.rows || []).map((r) => r);
  const grid = efRowsToGrid(rows);
  // 키워드·사이즈(·지시서 수치)와 맞은 칸 = 초록, 맞은 칸 있는 줄 = 연한 초록 (기존 명세서 찾기와 같은 모양)
  const hitRows = grid.map((g) => ({
    code: cellMatches(g.품목코드, keywords, false),
    item: cellMatches(g.품목, keywords, false),
    spec: cellMatches(g.규격, keywords, true, dims),
  }));
  const filledCells = grid.reduce((a, g) => a + [g.품목코드, g.품목, g.규격].filter((x) => (x || '').trim()).length, 0);
  const hitCells = hitRows.reduce((a, h) => a + Number(h.code) + Number(h.item) + Number(h.spec), 0);
  const nos = extractOrderNos(rows.map((r) => r.remark || '').join(' '));
  const own = orderNoCore(order.orderNumber);
  const reasons: { t: string; good: boolean }[] = [];
  if (nos.includes(own)) reasons.push({ t: '비고에 이 주문번호 있음', good: true });
  else if (nos.length) reasons.push({ t: `비고엔 다른 주문번호(${nos.join(', ')})`, good: false });
  reasons.push({ t: best.client >= 0.85 ? '거래처 같음' : `거래처 비슷함 (${Math.round(best.client * 100)}%)`, good: best.client >= 0.85 });
  reasons.push({ t: best.days === 0 ? '날짜 같음' : `날짜 ${best.days}일 차이`, good: best.days <= 3 });
  if (best.title >= 0.5) reasons.push({ t: '현장명 일치', good: true });
  if (best.clueN)
    reasons.push({ t: `키워드 일치 ${best.clueHit}/${best.clueN}`, good: best.clueHit === best.clueN });
  if (match.mergedWith?.length)
    reasons.push({ t: `합친 명세서 — 주문 ${mergedNos.join(', ')} 와(과) 같이 써요`, good: true });
  if (best.dimN) reasons.push({ t: `규격 치수 지시서와 일치 ${best.dimHit}/${best.dimN}`, good: (best.dimHit || 0) / best.dimN >= 0.6 });

  return (
    <div className="efb-detail" role="dialog" aria-label="지시서와 명세서 비교" onClick={onClose}>
      <div className="efb-dbox" onClick={(e) => e.stopPropagation()}>
        <div className="efb-dhead">
          <button type="button" className="efb-dnav" onClick={() => onNav(-1)} disabled={index <= 0} aria-label="이전 지시서">‹</button>
          <span className="efb-dpos">{index + 1} / {total}</span>
          <button type="button" className="efb-dnav" onClick={() => onNav(1)} disabled={index >= total - 1} aria-label="다음 지시서">›</button>
          <span className="efb-dorder">
            <b>{order.clientCompanyName}</b> · {order.title || ''} <small>{own}{order.dueDate ? ` · ${shortDate(order.dueDate)} 납` : ''}</small>
          </span>
          <button type="button" className="efb-x efb-x--light" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="efb-dbody">
          <div className="efb-dws">
            <FitWorksheet pdfUrl={order.worksheetPdfUrl} thumbUrl={order.worksheetThumbnailUrl} title={order.title} />
          </div>
          <div className="efb-dstmt">
            <div className="efb-dstmt-head">
              <span className={`efb-biz efb-biz--${best.row.biz}`}>{bizLabel(best.row.biz)} 이지폼</span>
              <span className="efb-dstmt-client">{best.row.client}</span>
              <span className="efb-dstmt-date">발행 {read?.date || best.row.date}{best.row.written && best.row.written !== best.row.date ? ` · 작성 ${best.row.written}` : ''}</span>
              <span className="efb-dstmt-total">{won(read?.total || best.row.total)}원</span>
            </div>
            <div className="efb-reasons">
              {reasons.map((r, i) => (
                <span key={i} className={r.good ? 'good' : 'warn'}>{r.good ? '✓' : '!'} {r.t}</span>
              ))}
            </div>
            {(keywords.length > 0 || (dims && dims.length > 0)) && (
              <div className="efb-hitcount">
                맞은 칸 <b>{hitCells}</b> / 전체 {filledCells}칸
                <span>{keywords.length ? `키워드 ${keywords.join(', ')}` : ''}{keywords.length && dims?.length ? ' · ' : ''}{dims?.length ? '규격은 지시서 수치와도 비교' : ''}</span>
              </div>
            )}
            <div className="efb-table-wrap">
              <table className="efb-table">
                <thead>
                  <tr>
                    <th style={{ width: '15%' }}>품목코드</th>
                    <th>품목</th>
                    <th style={{ width: '17%' }}>규격</th>
                    <th style={{ width: '8%' }}>수량</th>
                    <th style={{ width: '13%' }}>단가</th>
                    <th style={{ width: '14%' }}>공급가액</th>
                  </tr>
                </thead>
                <tbody>
                  {grid.map((g, i) => {
                    const h = hitRows[i];
                    return (
                      <tr key={i} className={h.code || h.item || h.spec ? 'has-hit' : undefined}>
                        <td className={h.code ? 'hit' : undefined}>{g.품목코드}</td>
                        <td className={`efb-td-item${h.item ? ' hit' : ''}`}>{g.품목}</td>
                        <td className={h.spec ? 'hit' : undefined}>{g.규격}</td>
                        <td className="num">{g.수량}</td>
                        <td className="num">{won(g.단가)}</td>
                        <td className="num">{won(g.공급가액)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {match.others.length > 0 && (
              <div className="efb-others">
                <div className="efb-others-label">다른 후보</div>
                <div className="efb-others-list">
                  {match.others.map((c) => (
                    <button
                      type="button"
                      key={c.key}
                      className="efb-other"
                      onClick={() => onUse(c)}
                      disabled={!!swapping}
                      title="이 명세서로 바꿔서 보기 (이지폼에서 읽어와요)"
                    >
                      {swapping === c.key ? (
                        <span><span className="efb-spin" /> 읽는 중…</span>
                      ) : (
                        <>
                          <span className={`efb-biz efb-biz--${c.row.biz}`}>{bizLabel(c.row.biz)}</span>
                          <span>{shortDate(c.row.date)}</span>
                          <b>{c.row.client}</b>
                          <span className="efb-other-item">{c.row.firstItem}</span>
                          <span>{won(c.row.total)}원</span>
                          {c.usedBy?.length ? <span className="efb-other-used">이미 저장됨 · 고르면 같이 쓰기</span> : null}
                          {reads[c.key]?.ok && <span className="efb-other-read">읽음</span>}
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="efb-dfoot">
              {saved && <span className="efb-saved-note">이미 홈페이지에 저장했어요</span>}
              <button type="button" className={`efb-no ${verdict === 'no' ? 'on' : ''}`} onClick={() => onMark('no')} disabled={!!swapping || saved}>
                ✕ 아니에요 <kbd>X</kbd>
              </button>
              <button type="button" className={`efb-yes ${verdict === 'yes' ? 'on' : ''}`} onClick={() => onMark('yes')} disabled={!!swapping || saved}>
                ✓ 맞아요 <kbd>Enter</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 비교창 지시서 — 칸에 꽉 차게(스크롤 없이) 가로·세로 중 맞는 쪽에 맞춰 PDF 1쪽을 그린다. */
function FitWorksheet({ pdfUrl, thumbUrl, title }: { pdfUrl?: string | null; thumbUrl?: string | null; title?: string | null }) {
  // 넘기자마자 보이게: ① 미리 만들어 둔 미리보기 사진(JPEG)을 즉시 ② 선명한 PDF 가 다 그려지면 그 위로 바꿔 끼움.
  // 크기는 미리보기 사진 비율로 먼저 정해 PDF 를 두 번 그리지 않는다.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState<number | null>(null); // 가로/세로
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [thumbBad, setThumbBad] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const upd = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    upd();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setRatio(null);
    setFailed(false);
    setRendered(false);
    setThumbBad(false);
  }, [pdfUrl, thumbUrl]);
  const fit = (r: number) => Math.floor(Math.min(size.w, size.h * r));
  const width = size.w && size.h ? fit(ratio || 0.75) : 0;
  const ph = thumbUrl && !thumbBad ? (
    <img
      className="efb-fit-img"
      src={thumbUrl}
      alt="지시서"
      style={ratio && width ? { width, height: Math.floor(width / ratio) } : undefined}
      onLoad={(e) => {
        const im = e.currentTarget;
        if (!ratio && im.naturalWidth && im.naturalHeight) setRatio(im.naturalWidth / im.naturalHeight);
      }}
      onError={() => setThumbBad(true)}
    />
  ) : null;
  if (!pdfUrl || failed) {
    return (
      <div className="efb-fit" ref={box}>
        {ph || <div className="efb-ws-empty">{title || '지시서 없음'}</div>}
      </div>
    );
  }
  // 미리보기 사진이 있으면 비율을 알 때까지(사진 로드) PDF 를 그리지 않는다 — 한 번만 그리게.
  const canDraw = width > 0 && (ratio != null || !thumbUrl || thumbBad);
  return (
    <div className="efb-fit" ref={box}>
      {!rendered && (ph || <span className="efb-spin" />)}
      {canDraw && (
        <div className={rendered ? 'efb-fit-pdf' : 'efb-fit-pdf is-loading'}>
          <Document file={pdfUrl} loading={null} error={null} onLoadError={() => setFailed(true)}>
            <Page
              pageNumber={1}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              devicePixelRatio={Math.min(2.5, window.devicePixelRatio || 1)}
              loading={null}
              onLoadSuccess={(p) => !ratio && setRatio(p.originalWidth / p.originalHeight)}
              onRenderSuccess={() => setRendered(true)}
            />
          </Document>
        </div>
      )}
    </div>
  );
}

/** 다음 지시서들 미리 받아 두기 — 미리보기 사진 + PDF(브라우저 캐시). 넘기는 순간 바로 뜨게. */
const prefetched = new Set<string>();
function prefetchWorksheets(list: (EfBulkOrder | undefined)[]) {
  for (const o of list) {
    if (!o) continue;
    if (o.worksheetThumbnailUrl && !prefetched.has(o.worksheetThumbnailUrl)) {
      prefetched.add(o.worksheetThumbnailUrl);
      const im = new Image();
      im.src = o.worksheetThumbnailUrl;
    }
    if (o.worksheetPdfUrl && !prefetched.has(o.worksheetPdfUrl)) {
      prefetched.add(o.worksheetPdfUrl);
      fetch(o.worksheetPdfUrl, { cache: 'force-cache' }).catch(() => prefetched.delete(o.worksheetPdfUrl!));
    }
  }
}

/**
 * 단서 입력 — 지시서를 크게 띄워 두고 키워드·사이즈를 치고 Enter 만 누르면 다음 지시서로.
 * 빈칸 Enter = 건너뛰기, Shift+Enter = 이전, 빈칸 Backspace = 마지막 단서 지우기, Esc = 목록으로.
 */
function ClueEntry({
  orders,
  pos,
  setPos,
  clues,
  setClues,
  onBack,
  onStart,
  single = false,
}: {
  orders: EfBulkOrder[];
  pos: number;
  setPos: (p: number) => void;
  clues: Record<number, string[]>;
  setClues: (f: (prev: Record<number, string[]>) => Record<number, string[]>) => void;
  onBack: () => void;
  onStart: (clues: Record<number, string[]>) => void;
  single?: boolean;
}) {
  const [text, setText] = useState('');
  const [delArmed, setDelArmed] = useState(false); // 빈칸 Backspace 1번 = 지울 준비, 2번 = 지움(키워드로 찾기와 같음)
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const n = orders.length;
  const o = orders[Math.min(pos, n - 1)];
  const mine = (o && clues[o.id]) || [];
  useEffect(() => {
    input.current?.focus();
    listRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
    prefetchWorksheets([orders[pos + 1], orders[pos + 2], orders[pos - 1]]);
  }, [pos, orders]);
  if (!o) return null;
  const setMine = (list: string[]) =>
    setClues((prev) => {
      const next = { ...prev };
      if (list.length) next[o.id] = list;
      else delete next[o.id];
      return next;
    });
  const go = (d: number) => {
    setText('');
    setDelArmed(false);
    setPos(Math.max(0, Math.min(n - 1, pos + d)));
  };
  const norm = (x: string) => x.replace(/\s+/g, '').toLowerCase();
  // 찾기 — 칸에 쳐 두고 Enter 안 누른 글자도 키워드로 넣는다. 키워드가 하나도 없으면 = 바로 찾기.
  const startNow = () => {
    const w = text.trim();
    const next = { ...clues };
    if (w && !mine.some((c) => norm(c) === norm(w))) next[o.id] = [...mine, w];
    setText('');
    onStart(next);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 는 글자 확정용(칩 2개 방지)
    if (e.key !== 'Backspace') setDelArmed(false);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) return go(-1);
      const w = text.trim();
      if (w) {
        // 키워드 하나 추가 — 같은 지시서에 계속 쌓는다(키워드로 찾기와 같은 방식)
        if (!mine.some((c) => norm(c) === norm(w))) setMine([...mine, w]);
        setText('');
      } else if (pos < n - 1) {
        go(1); // 빈칸 Enter = 다음 지시서
      } else if (single) {
        startNow(); // 1건일 때 빈칸 Enter = 찾기
      }
    } else if (e.key === 'Backspace' && !text && mine.length) {
      e.preventDefault();
      if (!delArmed) setDelArmed(true);
      else {
        setMine(mine.slice(0, -1));
        setDelArmed(false);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  };
  const done = Object.keys(clues).length;
  return (
    <div className="efb-clue">
      <div className="efb-clue-ws">
        <FitWorksheet pdfUrl={o.worksheetPdfUrl} thumbUrl={o.worksheetThumbnailUrl} title={o.title} />
      </div>
      <aside className="efb-clue-side">
        <div className="efb-clue-head">
          <span className="efb-clue-pos">
            <b>{pos + 1}</b> / {n}
          </span>
          <span className="efb-clue-done">키워드 넣은 지시서 {done}개</span>
        </div>
        <div className="efb-clue-order">
          <b>{o.clientCompanyName || '거래처 없음'}</b>
          <span>
            {shortDate(o.dueDate || o.createdAt)}
            {o.dueDate ? ' 납' : ''} · {orderNoCore(o.orderNumber)}
          </span>
        </div>
        <label className="efb-clue-label" htmlFor="efb-clue-input">
          이 지시서의 키워드 · 사이즈
        </label>
        <input
          id="efb-clue-input"
          ref={input}
          className="efb-clue-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDelArmed(false);
          }}
          onBlur={() => setDelArmed(false)}
          onKeyDown={onKey}
          placeholder={mine.length ? '키워드 더 넣기 · 빈칸 Enter = 다음' : '한 단어씩 치고 Enter — 예: 갈바 ⏎ 2400*600 ⏎'}
          autoComplete="off"
        />
        <div className="efb-clue-chips">
          {mine.map((c, i) => (
            <span
              key={c}
              className={`efb-clue-chip ${delArmed && i === mine.length - 1 ? 'is-armed' : ''}`}
              title={delArmed && i === mine.length - 1 ? 'Backspace 한 번 더 누르면 지워져요' : undefined}
            >
              {c}
              <button type="button" onClick={() => setMine(mine.filter((x) => x !== c))} aria-label={`${c} 지우기`}>
                ✕
              </button>
            </span>
          ))}
          {!mine.length && <span className="efb-clue-none">키워드 없음 — 거래처·납기·지시서 수치로 찾아요</span>}
        </div>
        <p className="efb-clue-help">
          키워드 치고 <kbd>Enter</kbd> = 하나씩 추가 · 빈칸 <kbd>Enter</kbd> = 다음 지시서 · <kbd>Shift+Enter</kbd> = 이전 ·
          빈칸 <kbd>Backspace</kbd> 두 번 = 지우기
        </p>
        <div className="efb-clue-list" ref={listRef}>
          {orders.map((x, i) => (
            <button
              type="button"
              key={x.id}
              className={`efb-clue-row ${i === pos ? 'is-on' : ''}`}
              onClick={() => {
                setText('');
                setPos(i);
              }}
            >
              <span className="efb-clue-row-date">{shortDate(x.dueDate || x.createdAt)}</span>
              <span className="efb-clue-row-client">{x.clientCompanyName}</span>
              <span className="efb-clue-row-clues">{(clues[x.id] || []).join(', ')}</span>
            </button>
          ))}
        </div>
        <div className="efb-clue-btns">
          {!single && (
            <button type="button" className="efb-secondary" onClick={onBack}>
              목록으로
            </button>
          )}
          <button type="button" className="efb-primary" onClick={startNow}>
            {single ? (mine.length || text.trim() ? '찾기' : '바로 찾기') : '입력 끝 · 찾기 시작'}
          </button>
        </div>
      </aside>
    </div>
  );
}
