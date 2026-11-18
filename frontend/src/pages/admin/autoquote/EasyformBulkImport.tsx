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
  worksheetDims,
  type EfMatch,
  type EfCandidate,
  type EfOrder,
} from './data/efMatch';
import { BASE_URL, getEasyformUsedKeys, syncEstimateFromEasyform } from './annot/api';
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
}

type Phase = 'intro' | 'export' | 'read' | 'review' | 'saving' | 'saved';
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

export default function EasyformBulkImport({ orders: ordersProp, token, onClose, onSaved }: Props) {
  // 열 때의 목록으로 고정 — 저장하면서 부모 목록이 줄어들어도 화면이 흔들리지 않게.
  // 오래된 날짜순. 찾고 나면 '찾은 것 먼저(왼쪽) → 각각 오래된 날짜순'으로 다시 줄 세운다.
  const [orders, setOrders] = useState(() => [...ordersProp].sort(byDate));
  const [eta, setEta] = useState('');
  const [pauseWanted, setPauseWanted] = useState(false);
  const [pausedNow, setPausedNow] = useState(false);
  const [phase, setPhase] = useState<Phase>('intro');
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
  const jobRef = useRef<{ id: number; stop: boolean } | null>(null);
  const matchRef = useRef<Record<number, EfMatch>>({});
  const readsRef = useRef<Record<string, EfBulkResult>>({});
  const dimsRef = useRef<Record<number, number[] | undefined>>({});
  const dimsWait = useRef<Promise<void>>(Promise.resolve());
  const phaseRef = useRef<Phase>('intro');
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1200);

  const busy = phase === 'export' || phase === 'read' || phase === 'saving' || !!swapping;
  phaseRef.current = phase;
  const n = orders.length;

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (jobRef.current) {
        jobRef.current.stop = true;
        cancelEfBulk(jobRef.current.id);
      }
    },
    [],
  );

  const go = useCallback((d: number) => setPos((p) => Math.max(0, Math.min(n - 1, p + d))), [n]);

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

  const start = async () => {
    setError('');
    const probe = await probeEasyformAgent();
    if (!probe?.easyform) {
      setError('이 PC 에서 워처가 꺼져 있거나 이지폼 자동화를 쓸 수 없어요. 워처를 켜고 다시 해주세요.');
      return;
    }
    setPhase('export');
    setProgress('이지폼에서 명세서 목록을 뽑고 있어요');
    try {
      const [used, exp] = await Promise.all([getEasyformUsedKeys(token), runJob({ phase: 'export' })]);
      const rows: EfListRow[] = (exp.lists || []).flatMap((l) => l.rows);
      const ms = matchOrders(orders, rows, used);
      const map: Record<number, EfMatch> = {};
      ms.forEach((m) => (map[m.order.id] = m));
      matchRef.current = map;
      setMatches(map);
      // 짝 찾은 지시서 먼저(왼쪽부터), 각각 오래된 날짜순
      setOrders((prev) => [...prev].sort((a, b) => Number(!!map[b.id]?.best) - Number(!!map[a.id]?.best) || byDate(a, b)));
      setPos(0);
      // 헷갈리는 지시서(같은 거래처·비슷한 점수 후보)는 후보를 최대 3개 같이 읽는다 → 지시서 수치로 다시 매김
      const seen = new Set<string>();
      const items = ms
        .flatMap((m) => candidatesToRead(m))
        .filter((c) => !seen.has(c.key) && seen.add(c.key))
        .map((c) => ({ ...c.row, key: c.key }));
      dimsWait.current = loadDims(ms.filter((m) => candidatesToRead(m).length > 1).map((m) => m.order as EfBulkOrder));
      if (!items.length) {
        setPhase('review');
        setProgress('');
        return;
      }
      setPhase('read');
      setProgress(`후보 명세서 ${items.length}건을 이지폼에서 읽고 있어요`);
      setEta(etaText(items.length * SEC_PER_READ));
      // 남은 시간 — 지금까지 1건당 걸린 시간(일시정지 시간 뺌) × 남은 건수
      const t0 = Date.now();
      let pausedMs = 0;
      let lastTick = t0;
      const fin = await runJob({ phase: 'read', items }, (s) => {
        applyResults(s.results);
        const now = Date.now();
        if (s.paused) pausedMs += now - lastTick;
        lastTick = now;
        const done = s.results?.length || 0;
        const per = done ? (now - t0 - pausedMs) / 1000 / done : SEC_PER_READ;
        setEta(s.paused ? '' : etaText(per * (items.length - done)));
      });
      applyResults(fin.results);
      await dimsWait.current;
      finishRead(fin.results);
    } catch (e) {
      const st = (e as { status?: { results?: EfBulkResult[] } }).status;
      applyResults(st?.results);
      setError((e as Error).message);
      // 읽다가 멈췄어도 읽은 것까지는 확인할 수 있게 review 로.
      if (phaseRef.current === 'read') {
        await dimsWait.current;
        finishRead(st?.results);
      }
      else setPhase('intro');
      setProgress('');
    } finally {
      setEta('');
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
  const finishRead = (rs?: EfBulkResult[]) => {
    (rs || []).forEach((x) => (readsRef.current[x.key] = x));
    const map = rescoreByContent(matchRef.current, readsRef.current, dimsRef.current);
    matchRef.current = map;
    setMatches(map);
    const ok = new Set(Object.values(readsRef.current).filter((x) => x.ok).map((x) => x.key));
    const rank = (o: EfBulkOrder) => (map[o.id]?.best && ok.has(map[o.id].best!.key) ? 0 : map[o.id]?.best ? 1 : 2);
    setOrders((prev) => [...prev].sort((a, b) => rank(a) - rank(b) || byDate(a, b)));
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

  const mark = (orderId: number, v: Verdict) => {
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
    const groups = new Map<string, EfBulkOrder[]>();
    for (const o of [...yesList].sort(byDate)) {
      const k = matches[o.id].best!.key;
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
          await syncEstimateFromEasyform(token, {
            orderNumbers: g.map((o) => orderNoCore(o.orderNumber)),
            grid,
            total: sum,
            source: 'batch',
            efDate: rd.date || m.best!.row.date,
            efTotal: rd.total || m.best!.row.total,
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

  const CARD_W = 300;
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
                    className={`efb-col ${i === pos ? 'is-active' : ''} ${v ? `is-${v}` : ''} ${savedIds.has(o.id) ? 'is-saved' : ''}`}
                    style={{ width: CARD_W, marginRight: GAP, ...(dist > 4 ? { opacity: 0 } : {}) }}
                    onClick={() => setPos(i)}
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
                          {m.mergedWith?.length ? (
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
            onChange={(e) => setPos(Number(e.target.value))}
            aria-label="지시서 넘기기"
            style={{ ['--efb-p' as string]: `${n > 1 ? (pos / (n - 1)) * 100 : 0}%` }}
          />
        </div>
      )}

      <footer className="efb-foot">
        <div className="efb-count">
          <b>{n ? pos + 1 : 0}</b> / {n}
        </div>
        {phase === 'intro' && (
          <div className="efb-cta">
            <p className="efb-lead">
              총 <b>{n}개</b> 명세서를 이지폼에서 찾아볼게요
            </p>
            <p className="efb-sub">
              주식회사·개인 이지폼 2개를 켜 두세요(최소화해도 돼요). 이지폼에 작성 중인 명세서 창이 열려 있으면 멈춰요.
            </p>
            <button type="button" className="efb-primary" onClick={start} disabled={!n}>확인</button>
          </div>
        )}
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
}) {
  const best = match.best!;
  const rows = (read?.rows || []).map((r) => r);
  const grid = efRowsToGrid(rows);
  const nos = extractOrderNos(rows.map((r) => r.remark || '').join(' '));
  const own = orderNoCore(order.orderNumber);
  const reasons: { t: string; good: boolean }[] = [];
  if (nos.includes(own)) reasons.push({ t: '비고에 이 주문번호 있음', good: true });
  else if (nos.length) reasons.push({ t: `비고엔 다른 주문번호(${nos.join(', ')})`, good: false });
  reasons.push({ t: best.client >= 0.85 ? '거래처 같음' : `거래처 비슷함 (${Math.round(best.client * 100)}%)`, good: best.client >= 0.85 });
  reasons.push({ t: best.days === 0 ? '날짜 같음' : `날짜 ${best.days}일 차이`, good: best.days <= 3 });
  if (best.title >= 0.5) reasons.push({ t: '현장명 일치', good: true });
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
                  {grid.map((g, i) => (
                    <tr key={i}>
                      <td>{g.품목코드}</td>
                      <td className="efb-td-item">{g.품목}</td>
                      <td>{g.규격}</td>
                      <td className="num">{g.수량}</td>
                      <td className="num">{won(g.단가)}</td>
                      <td className="num">{won(g.공급가액)}</td>
                    </tr>
                  ))}
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
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState<number | null>(null); // 가로/세로
  const [failed, setFailed] = useState(false);
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
  }, [pdfUrl]);
  const width = size.w && size.h ? (ratio ? Math.floor(Math.min(size.w, size.h * ratio)) : Math.floor(Math.min(size.w, size.h * 0.75))) : 0;
  const fallback = thumbUrl ? (
    <img className="efb-fit-img" src={thumbUrl} alt="지시서" />
  ) : (
    <div className="efb-ws-empty">{title || '지시서 없음'}</div>
  );
  return (
    <div className="efb-fit" ref={box}>
      {!pdfUrl || failed ? (
        fallback
      ) : width > 0 ? (
        <Document file={pdfUrl} loading={<span className="efb-spin" />} error={fallback} onLoadError={() => setFailed(true)}>
          <Page
            pageNumber={1}
            width={width}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            devicePixelRatio={Math.min(2.5, window.devicePixelRatio || 1)}
            onLoadSuccess={(p) => setRatio(p.originalWidth / p.originalHeight)}
          />
        </Document>
      ) : null}
    </div>
  );
}
