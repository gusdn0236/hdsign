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
import WorksheetThumbnailJs from '../../../components/common/WorksheetThumbnail.jsx';
import {
  startEfBulk,
  pollEfBulk,
  cancelEfBulk,
  probeEasyformAgent,
  extractOrderNos,
  orderNoCore,
  type EfListRow,
  type EfBulkResult,
} from './data/easyformClient';
import { matchOrders, efRowsToGrid, rememberClientAlias, type EfMatch, type EfCandidate, type EfOrder } from './data/efMatch';
import { getEasyformUsedKeys, syncEstimateFromEasyform } from './annot/api';
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

export default function EasyformBulkImport({ orders: ordersProp, token, onClose, onSaved }: Props) {
  // 열 때의 목록으로 고정 — 저장하면서 부모 목록이 줄어들어도 화면이 흔들리지 않게.
  const [orders] = useState(ordersProp);
  const [phase, setPhase] = useState<Phase>('intro');
  const [pos, setPos] = useState(0);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<Record<number, EfMatch>>({});
  const [reads, setReads] = useState<Record<string, EfBulkResult>>({});
  const [verdict, setVerdict] = useState<Record<number, Verdict>>({});
  const [detail, setDetail] = useState<number | null>(null); // 열린 비교창의 주문 id
  const [swapping, setSwapping] = useState('');
  const [saveResult, setSaveResult] = useState<{ ok: number; fail: { order: EfBulkOrder; msg: string }[] } | null>(null);
  const jobRef = useRef<{ id: number; stop: boolean } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1200);

  const busy = phase === 'export' || phase === 'read' || phase === 'saving' || !!swapping;
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
      setMatches(map);
      const items = ms.filter((m) => m.best).map((m) => ({ ...m.best!.row, key: m.best!.key }));
      if (!items.length) {
        setPhase('review');
        setProgress('');
        return;
      }
      setPhase('read');
      setProgress(`짝지은 명세서 ${items.length}건을 이지폼에서 읽고 있어요`);
      // 지시서 순서대로 읽히는 게 보기 좋지만, 워처는 목록 위→아래로 움직이는 게 빠르다 → 워처가 정렬.
      const fin = await runJob({ phase: 'read', items }, (s) => applyResults(s.results));
      applyResults(fin.results);
      setPhase('review');
      setProgress('');
    } catch (e) {
      const st = (e as { status?: { results?: EfBulkResult[] } }).status;
      applyResults(st?.results);
      setError((e as Error).message);
      // 읽다가 멈췄어도 읽은 것까지는 확인할 수 있게 review 로.
      setPhase((p) => (p === 'read' ? 'review' : 'intro'));
      setProgress('');
    }
  };

  const cancel = () => {
    if (jobRef.current) {
      jobRef.current.stop = true;
      cancelEfBulk(jobRef.current.id);
    }
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
        Object.values(next).forEach((m) => {
          if (m.order.id !== orderId && m.best?.key === c.key) {
            next[m.order.id] = { ...m, best: null, others: [c, ...m.others] };
          }
        });
        const me = next[orderId];
        const old = me.best;
        next[orderId] = { ...me, best: c, others: [...(old ? [old] : []), ...me.others.filter((x) => x.key !== c.key)], sure: false };
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

  const yesList = orders.filter((o) => verdict[o.id] === 'yes' && matches[o.id]?.best && reads[matches[o.id].best!.key]?.ok);

  const save = async () => {
    setPhase('saving');
    setError('');
    let ok = 0;
    const fail: { order: EfBulkOrder; msg: string }[] = [];
    const queue = [...yesList];
    const worker = async () => {
      for (let o = queue.shift(); o; o = queue.shift()) {
        const m = matches[o.id];
        const rd = reads[m.best!.key];
        try {
          const grid = efRowsToGrid(rd.rows || []);
          const sum = grid.reduce((a, g) => a + (Number(g.공급가액) || 0), 0);
          await syncEstimateFromEasyform(token, {
            orderNumbers: [orderNoCore(o.orderNumber)],
            grid,
            total: sum,
            source: 'batch',
            efDate: rd.date || m.best!.row.date,
            efTotal: rd.total || m.best!.row.total,
          });
          rememberClientAlias(o.clientCompanyName, m.best!.row.client);
          onSaved(o.id);
          ok++;
        } catch (e) {
          fail.push({ order: o, msg: (e as Error).message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    setSaveResult({ ok, fail });
    setPhase('saved');
  };

  // 키보드 — ←/→ 넘기기, 비교창: Enter 맞아요 · X 아니에요 · Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
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
      else if (e.key === 'Escape' && !busy) onClose();
      else if (e.key === 'Enter' && phase === 'review') {
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

  const CARD_W = 248;
  const GAP = 28;
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
            ['저장', phase === 'saving' || phase === 'saved'],
          ].map(([label, on], i) => (
            <li key={i} className={on ? 'on' : ''}>
              <b>{i + 1}</b>
              {label}
            </li>
          ))}
        </ol>
        <button type="button" className="efb-x" onClick={busy ? cancel : onClose} title={busy ? '멈추기' : '닫기 (Esc)'}>
          {busy ? '멈추기' : '✕'}
        </button>
      </header>

      {(phase === 'export' || phase === 'read' || progress) && (
        <div className="efb-progress">
          <span className="efb-spin" aria-hidden="true" />
          <span>{progress || '이지폼 작업 중'}</span>
          <span className="efb-progress-hint">이지폼은 숨은 채로 작업해요 · 그동안 이지폼은 만지지 마세요 · ESC 로 멈춤</span>
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
                    className={`efb-col ${i === pos ? 'is-active' : ''} ${v ? `is-${v}` : ''}`}
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
                        {v && <span className={`efb-mark efb-mark--${v}`}>{v === 'yes' ? '✓' : '✕'}</span>}
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
                          if (phase === 'review') setDetail(o.id);
                        }}
                        disabled={phase !== 'review'}
                        title={phase === 'review' ? '눌러서 지시서와 나란히 보기' : '다 읽은 뒤에 확인할 수 있어요'}
                      >
                        <span className="efb-ef-top">
                          <span className={`efb-biz efb-biz--${m.best.row.biz}`}>{bizLabel(m.best.row.biz)}</span>
                          <span className="efb-ef-date">{shortDate(rd.date || m.best.row.date)}</span>
                          {sure && <span className="efb-sure" title="이지폼 비고에 이 주문번호가 적혀 있어요">주문번호 ✓</span>}
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
        {(phase === 'export' || phase === 'read') && (
          <div className="efb-cta">
            <p className="efb-lead">이지폼에서 찾고 있어요 · 찾은 명세서가 지시서 아래에 나타나요</p>
          </div>
        )}
        {phase === 'review' && (
          <div className="efb-cta efb-cta--row">
            <div className="efb-tally">
              <span className="t-yes">맞음 <b>{stats.yes}</b></span>
              <span className="t-no">아님 <b>{stats.no}</b></span>
              <span className="t-left">남음 <b>{stats.left}</b></span>
              {stats.none > 0 && <span className="t-none">못 찾음 {stats.none}</span>}
            </div>
            <p className="efb-sub">명세서를 눌러 지시서와 비교하세요 · ←/→ 넘기기 · Enter 열기</p>
            <button type="button" className="efb-primary" onClick={save} disabled={!yesList.length}>
              {yesList.length ? `${yesList.length}건 홈페이지에 저장` : '맞는 명세서를 체크하세요'}
            </button>
          </div>
        )}
        {phase === 'saving' && (
          <div className="efb-cta">
            <p className="efb-lead"><span className="efb-spin" /> {yesList.length}건 저장하는 중…</p>
          </div>
        )}
        {phase === 'saved' && saveResult && (
          <div className="efb-cta efb-cta--row">
            <p className="efb-lead">
              <b>{saveResult.ok}건</b>을 홈페이지 명세서에 넣었어요
              {saveResult.fail.length > 0 && <span className="efb-failnote"> · {saveResult.fail.length}건 실패</span>}
            </p>
            {saveResult.fail.length > 0 && (
              <ul className="efb-faillist">
                {saveResult.fail.map((f) => (
                  <li key={f.order.id}>{orderNoCore(f.order.orderNumber)} {f.order.clientCompanyName} — {f.msg}</li>
                ))}
              </ul>
            )}
            <button type="button" className="efb-primary" onClick={onClose}>닫기</button>
          </div>
        )}
      </footer>

      {detailOrder && matches[detailOrder.id]?.best && (
        <DetailView
          order={detailOrder}
          match={matches[detailOrder.id]}
          read={reads[matches[detailOrder.id].best!.key]}
          reads={reads}
          verdict={verdict[detailOrder.id]}
          index={orders.findIndex((o) => o.id === detailOrder.id)}
          total={n}
          swapping={swapping}
          onClose={() => setDetail(null)}
          onMark={(v) => mark(detailOrder.id, v)}
          onUse={(c) => pickCandidate(detailOrder.id, c)}
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
            <WorksheetThumbnail
              pdfUrl={order.worksheetPdfUrl || null}
              thumbnailUrl={order.worksheetPdfUrl ? null : order.worksheetThumbnailUrl || null}
              rootMargin="400px 0px"
              fallback={<div className="efb-ws-empty">{order.title || '지시서 없음'}</div>}
            />
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
              <button type="button" className={`efb-no ${verdict === 'no' ? 'on' : ''}`} onClick={() => onMark('no')} disabled={!!swapping}>
                ✕ 아니에요 <kbd>X</kbd>
              </button>
              <button type="button" className={`efb-yes ${verdict === 'yes' ? 'on' : ''}`} onClick={() => onMark('yes')} disabled={!!swapping}>
                ✓ 맞아요 <kbd>Enter</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
