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
import FitWorksheet from '../scrap/FitWorksheet';
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
import { clientSim, efRowsToGrid, normClient, rememberClientAlias } from './data/efMatch';
import './EasyformAutoSync.css';

// 추가한 줄 묻기 때 뒤에 '그 명세서' 화면을 미리보기로 깐다(사용자 2026-11-20: 명세서를 열어 추가된 줄 표시)
const AutoQuote = lazy(() => import('./AutoQuote'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PdfViewer = PdfViewerJs as unknown as ComponentType<any>;

interface Props {
  ev: EfAutoEvent;
  token: string | null | undefined;
  more: number; // 뒤에 기다리는 저장 수
  onClose: () => void;
}

// check = 비고 번호 있음 → 새 줄 확인 중 / added = 새 줄이 어느 지시서인지 묻는 중 / pick = 지시서 고르기
type Phase = 'check' | 'added' | 'pick' | 'saving' | 'done' | 'error';

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
  const [phase, setPhase] = useState<Phase>(ev.nos.length ? 'check' : 'pick');
  const [cands, setCands] = useState<EasyformCandidateOrder[] | null>(null); // null = 불러오는 중
  const [days, setDays] = useState(7);
  const [showAll, setShowAll] = useState(false);
  // 다른 지시서 더하기 = '같은 거래처' 지시서만(발행일 앞뒤 60일, 넓히면 120일). 일주일 넘게 지난 현장 건에 다음 주
  // 추가 발주를 같이 끊는 경우가 있어 날짜보다 거래처로 찾고, 다른 거래처를 같이 끊는 일은 없음(사용자 2026-11-20).
  const [clientDays, setClientDays] = useState(60);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<EasyformCandidateOrder | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [other, setOther] = useState(false); // 새 줄 = 다른 지시서 → 고르기 목록 펼침
  const [zoom, setZoom] = useState<EasyformCandidateOrder | null>(null); // 🔍 지시서 크게 보기
  const [msg, setMsg] = useState<{ main: string; sub?: string; warn?: string }>({ main: '' });
  const baseRef = useRef<EasyformCandidateOrder | null>(null); // 비고 번호의 (첫) 지시서

  // 이지폼 표 줄 ↔ 홈페이지 그리드 줄(빈 줄은 그리드에서 빠짐)
  const pairs = useMemo(
    () => ev.rows.map((r, i) => ({ i, g: efRowsToGrid([r])[0] })).filter((p) => !!p.g),
    [ev.rows],
  );
  const grid = useMemo(() => pairs.map((p) => p.g), [pairs]);
  const sum = useMemo(() => grid.reduce((a, r) => a + (Number(r.공급가액) || 0), 0), [grid]);

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
    async (orderNumbers: string[], stamp?: { o: EasyformCandidateOrder; row?: number; move?: boolean }) => {
      setPhase('saving');
      let rows = ev.rows;
      let warn = '';
      if (stamp) {
        const no = orderNoCore(stamp.o.orderNumber);
        const st = await stampEfAuto(ev.id, [no], stamp.row, !!stamp.move);
        if (st.ok && Array.isArray(st.rows) && st.rows.length === rows.length) {
          rows = st.rows; // 워처가 비고(적기·옮기기) 반영한 줄들
        } else if (st.ok && !st.skipped && typeof st.row === 'number' && rows[st.row]) {
          rows = rows.map((r, i) => (i === st.row ? { ...r, remark: st.remark || no } : r));
        } else if (!st.ok && stamp.move) {
          warn = `이지폼 비고의 주문번호를 맨 위로 못 옮겼어요 — ${st.message || '알 수 없는 이유'}`;
        } else if (!st.ok) {
          warn = `이지폼 비고엔 주문번호를 못 적었어요 — ${st.message || '알 수 없는 이유'}`;
          if (typeof stamp.row === 'number' && rows[stamp.row]) {
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
  }, [ready]);

  // 후보 지시서 — 고르기 화면이나 새 줄 묻기 화면에서
  useEffect(() => {
    if (!ready || (phase !== 'pick' && phase !== 'added')) return;
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
  }, [ready, phase === 'pick' || phase === 'added', days, clientDays]);

  // 다 끝나면 잠깐 보여 주고 닫기
  useEffect(() => {
    if (phase !== 'done' || msg.warn) return;
    const t = setTimeout(onClose, 2500); // 잠깐 보여 주고 이지폼으로 돌아감
    return () => clearTimeout(t);
  }, [phase, msg.warn, onClose]);

  const ranked: Ranked[] = useMemo(() => {
    const d0 = dayOf(ev.date);
    const skip = new Set(phase === 'added' ? ev.nos : []); // 새 줄 묻기: 이미 든 지시서는 빼고
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

  const confirm = () => {
    if (!picked) return;
    if (phase === 'added' && added) {
      // 새 줄 = 다른 지시서 → 이지폼 새 줄 첫 행 비고에 그 번호 + 합친 명세서(원래 번호들 먼저 = 대표 유지)
      save([...ev.nos, orderNoCore(picked.orderNumber)], { o: picked, row: added.evRow });
    } else {
      save([orderNoCore(picked.orderNumber)], { o: picked });
    }
  };

  const busy = phase === 'saving' || phase === 'check';
  const choosing = phase === 'pick' || (phase === 'added' && other); // 지시서 카드 목록을 보여줄 때
  const title =
    phase === 'pick'
      ? '어느 지시서의 명세서인가요?'
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
  const memberSave = (o: EasyformCandidateOrder) => {
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

  const onAq = !!added && phase !== 'pick'; // 뒤에 명세서 미리보기를 깔 때

  return (
    <>
      {onAq && added && (
        <div className="aq-modal-overlay efas-aqwrap" aria-hidden="true">
          <Suspense fallback={null}>
            <AutoQuote orderId={added.base.id} efPreview={preview} onClose={onClose} />
          </Suspense>
        </div>
      )}
    <div className={'efas' + (onAq ? ' on-aq' : '')} role="dialog" aria-modal="true" aria-label="이지폼 명세서 홈페이지 반영">
      <div className="efas-card">
        <header className="efas-head">
          <div>
            <p className="efas-kicker">
              이지폼 명세서{who ? ` · ${who}` : ''} · {fmtDay(ev.date)}
              {more > 0 && <span className="efas-more">+{more}건 대기</span>}
            </p>
            <h2 className="efas-title">{title}</h2>
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
        ) : (
          <section className="efas-stmt" aria-label="이지폼 명세서">
            <div className="efas-stmt-meta">
              <span className="efas-client">{ev.client || '거래처 못 읽음'}</span>
              <span>{fmtDay(ev.date)}</span>
              <b>{won(ev.total || sum)}</b>
            </div>
            {phase === 'pick' && (
              <div className="efas-rows">
                <table>
                  <tbody>
                    {grid.map((r, i) => (
                      <tr key={i}>
                        <td>{r.품목 || r.품목코드}</td>
                        <td>{r.규격}</td>
                        <td className="num">{r.수량}</td>
                        <td className="num">{price(r.단가)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
                {phase === 'added' && added ? (
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
            ) : visible.length ? (
              <ul className="efas-grid">
                {visible.slice(0, 24).map(({ o }) => (
                  <li key={o.id} className="efas-cand-li">
                    <button
                      type="button"
                      className="efas-zoombtn"
                      onClick={() => setZoom(o)}
                      aria-label={`${orderNoCore(o.orderNumber)} 지시서 크게 보기`}
                      title="크게 보기"
                    >
                      🔍
                    </button>
                    <button
                      type="button"
                      className={'efas-cand' + (picked?.id === o.id ? ' on' : '')}
                      onClick={() => setPicked(o)}
                      aria-pressed={picked?.id === o.id}
                    >
                      <div className="efas-thumb">
                        <FitWorksheet pdfUrl={o.worksheetPdfUrl} thumbUrl={o.worksheetThumbnailUrl} title={o.title} />
                      </div>
                      <div className="efas-cand-body">
                        <span className="efas-cand-client">{o.clientCompanyName || '거래처 없음'}</span>
                        <span className="efas-cand-sub">
                          {orderNoCore(o.orderNumber)} · 납기 {fmtDay(o.dueDate) || '없음'}
                        </span>
                        {o.title && <span className="efas-cand-title">{o.title}</span>}
                        {(o.hasEstimate || o.deletedAt) && (
                          <span className="efas-badges">
                            {o.hasEstimate && <i className="b-est">명세서 있음</i>}
                            {o.deletedAt && <i className="b-done">완료</i>}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
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
          </section>
        )}

        {busy && <div className="efas-busy">{phase === 'check' ? '확인하는 중…' : '반영하는 중…'}</div>}

        <footer className="efas-foot">
          {phase === 'added' && !other ? (
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
              <button type="button" className="efas-btn primary" disabled={!picked} onClick={confirm}>
                {picked ? '반영하기' : '지시서를 골라주세요'}
              </button>
            </>
          ) : (
            <>
              {phase === 'error' && (cands?.length || 0) > 0 && (
                <button type="button" className="efas-btn ghost" onClick={() => setPhase(added ? 'added' : 'pick')}>
                  다시 고르기
                </button>
              )}
              <button type="button" className="efas-btn primary" onClick={onClose} disabled={phase === 'saving'}>
                확인
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
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
                setPicked(zoom);
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
