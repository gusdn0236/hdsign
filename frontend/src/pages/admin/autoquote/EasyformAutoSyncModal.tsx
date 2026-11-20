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
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import WorksheetThumbnailJs from '../../../components/common/WorksheetThumbnail.jsx';
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
  releaseEfAuto,
  stampEfAuto,
  type EfAutoEvent,
} from './data/easyformClient';
import { clientSim, efRowsToGrid, normClient, rememberClientAlias } from './data/efMatch';
import './EasyformAutoSync.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WorksheetThumbnail = WorksheetThumbnailJs as unknown as ComponentType<any>;

interface Props {
  ev: EfAutoEvent;
  token: string | null | undefined;
  tab: string; // 이 탭 표시(내려놓기용)
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
  from: number; // 표(그리드) 기준 첫 새 줄
  evRow: number; // 이지폼 표 기준 첫 새 줄(비고 적을 곳)
  count: number;
  base: EasyformCandidateOrder; // 원래 지시서(비고 번호의 첫 주문)
}

export default function EasyformAutoSyncModal({ ev, token, tab, more, onClose: drop }: Props) {
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
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<EasyformCandidateOrder | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [other, setOther] = useState(false); // 새 줄 = 다른 지시서 → 고르기 목록 펼침
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
    document.title = `🧾 ${mark}`;
    let alive = true;
    (async () => {
      const ok = await frontEfAuto(mark);
      if (!alive) return;
      if (!ok && document.visibilityState === 'hidden') {
        // 브라우저에서 안 보이는 탭(다른 탭 뒤) → 앞으로 못 띄움. 내려놓으면 워처가 관리자 페이지를 새 탭으로 열고
        // 새 탭(저절로 맨 앞)이 이 건을 가져가 카드를 띄운다. 이 탭은 아무것도 반영하지 않고 조용히 빠진다.
        await releaseEfAuto(ev.id, tab);
        if (alive) drop();
        return;
      }
      setReady(true);
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
        const prefixSame = n > 0 && pairs.length > n && saved.every((r, k) => sig(r) === sig(pairs[k].g));
        const tail = prefixSame ? pairs.slice(n) : [];
        const tailHasNo = tail.some((p) => extractOrderNos(ev.rows[p.i]?.remark || '').length);
        if (base && tail.length && !tailHasNo) {
          setAdded({ from: n, evRow: tail[0].i, count: tail.length, base });
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
    getEasyformCandidates(tk, ev.date, days)
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
  }, [ready, phase === 'pick' || phase === 'added', days]);

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
    if (showAll) return ranked;
    const good = ranked.filter((r) => r.sim >= 0.5);
    return good.length ? good : ranked;
  }, [ranked, q, showAll]);
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
  const baseNo = added ? orderNoCore(added.base.orderNumber) : '';
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
  const sameSave = () => {
    if (added) save(ev.nos, ev.nos.length === 1 ? { o: added.base, move: true } : undefined);
  };

  return (
    <div className="efas" role="dialog" aria-modal="true" aria-label="이지폼 명세서 홈페이지 반영">
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
                {grid.slice(added.from).map((r, i) => (
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
            <button type="button" className="efas-opt" onClick={sameSave}>
              <div className="efas-opt-thumb">
                <WorksheetThumbnail
                  pdfUrl={added.base.worksheetPdfUrl}
                  thumbnailUrl={added.base.worksheetThumbnailUrl}
                  rootMargin="300px 0px"
                />
              </div>
              <b>같은 지시서</b>
              <span>{baseNo}</span>
            </button>
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
                {phase === 'added' || !clientKnown ? (
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
                  <li key={o.id}>
                    <button
                      type="button"
                      className={'efas-cand' + (picked?.id === o.id ? ' on' : '')}
                      onClick={() => setPicked(o)}
                      aria-pressed={picked?.id === o.id}
                    >
                      <div className="efas-thumb">
                        <WorksheetThumbnail pdfUrl={o.worksheetPdfUrl} thumbnailUrl={o.worksheetThumbnailUrl} rootMargin="300px 0px" />
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
              <p className="efas-empty">{q ? '찾는 지시서가 없어요.' : '지시서가 없어요.'}</p>
            )}
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
                {picked ? `${orderNoCore(picked.orderNumber)} 지시서가 맞아요` : '지시서를 눌러 골라주세요'}
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
  );
}
