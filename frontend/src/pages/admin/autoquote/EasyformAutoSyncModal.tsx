/**
 * 이지폼 저장 자동반영 — 확인 카드.
 *
 *  ① 비고에 이미 홈페이지 주문번호가 있으면(홈페이지에서 [이지폼 입력]했거나 예전에 이어 둔 명세서) 묻지 않고
 *     그 주문(들)의 홈페이지 명세서를 이지폼 내용으로 덮어쓴다.
 *  ② 없으면 발행일 근처 지시서를 거래처 닮음 순으로 카드로 보여 주고 "이 지시서가 맞나요?" →
 *     [맞아요] → 워처가 이지폼 비고에 주문번호를 적고 저장 → 홈페이지 명세서 덮어쓰기.
 * 이지폼이 참 데이터 — 홈페이지 명세서가 달라도 이지폼 내용으로 덮는다(사용자 결정 2026-11-20).
 */
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import WorksheetThumbnailJs from '../../../components/common/WorksheetThumbnail.jsx';
import { useAuth } from '../../../context/AuthContext';
import {
  getEasyformCandidates,
  syncEstimateFromEasyform,
  type EasyformCandidateOrder,
} from './annot/api';
import { frontEfAuto, orderNoCore, stampEfAuto, type EfAutoEvent } from './data/easyformClient';
import { clientSim, efRowsToGrid, normClient, rememberClientAlias } from './data/efMatch';
import './EasyformAutoSync.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WorksheetThumbnail = WorksheetThumbnailJs as unknown as ComponentType<any>;

interface Props {
  ev: EfAutoEvent;
  token: string | null | undefined;
  more: number; // 뒤에 기다리는 저장 수
  onClose: () => void;
}

type Phase = 'auto' | 'loading' | 'pick' | 'saving' | 'done' | 'error';

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

interface Ranked {
  o: EasyformCandidateOrder;
  sim: number;
  gap: number;
}

export default function EasyformAutoSyncModal({ ev, token, more, onClose }: Props) {
  const { token: ctxToken } = useAuth();
  const tk = token || ctxToken;
  const [phase, setPhase] = useState<Phase>(ev.nos.length ? 'auto' : 'loading');
  const [cands, setCands] = useState<EasyformCandidateOrder[]>([]);
  const [days, setDays] = useState(7);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<EasyformCandidateOrder | null>(null);
  const [msg, setMsg] = useState<{ main: string; sub?: string; warn?: string }>({ main: '' });

  const grid = useMemo(() => efRowsToGrid(ev.rows), [ev.rows]);
  const sum = useMemo(() => grid.reduce((a, r) => a + (Number(r.공급가액) || 0), 0), [grid]);

  // 직원은 이지폼을 보고 있다 → 이 탭 제목에 표시를 달고 워처에게 이 창을 앞으로 가져오게 한다.
  useEffect(() => {
    const old = document.title;
    const mark = `이지폼 명세서 확인 #${ev.id}`;
    document.title = `🧾 ${mark}`;
    frontEfAuto(mark);
    return () => {
      document.title = old;
    };
  }, [ev.id]);

  const save = async (orderNumbers: string[], stampTo?: EasyformCandidateOrder) => {
    setPhase('saving');
    let rows = ev.rows;
    let warn = '';
    if (stampTo) {
      // 이지폼 비고에 주문번호 먼저(다음에 또 저장하면 ①로 바로 반영되게). 못 적어도 홈페이지 반영은 한다.
      const st = await stampEfAuto(ev.id, orderNumbers);
      if (st.ok && !st.skipped && typeof st.row === 'number' && rows[st.row]) {
        rows = rows.map((r, i) => (i === st.row ? { ...r, remark: st.remark || orderNumbers.join(', ') } : r));
      } else if (!st.ok) {
        warn = `이지폼 비고엔 주문번호를 못 적었어요 — ${st.message || '알 수 없는 이유'}`;
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
      if (stampTo && ev.client) rememberClientAlias(stampTo.clientCompanyName, ev.client);
      const nos = res.linked.map((l) => orderNoCore(l.orderNumber));
      setMsg({
        main: '홈페이지 명세서에 반영했어요',
        sub: `주문 ${nos.join(', ')}${res.changed ? '' : ' · 바뀐 내용 없음'}`,
        warn,
      });
      setPhase('done');
      return true;
    } catch (e) {
      setMsg({ main: '홈페이지에 반영하지 못했어요', sub: (e as Error).message, warn });
      setPhase('error');
      return false;
    }
  };

  // ① 비고에 주문번호 → 바로 반영. 홈페이지에서 그 번호를 못 찾으면 ②로.
  useEffect(() => {
    if (phase !== 'auto') return;
    (async () => {
      const ok = await save(ev.nos);
      if (!ok) setPhase('loading');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ② 후보 지시서
  useEffect(() => {
    if (phase !== 'loading') return;
    let alive = true;
    getEasyformCandidates(tk, ev.date, days)
      .then((list) => {
        if (!alive) return;
        setCands(list);
        setPhase('pick');
      })
      .catch((e) => {
        if (!alive) return;
        setMsg({ main: '지시서 후보를 못 불러왔어요', sub: (e as Error).message });
        setPhase('error');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, days]);

  // 다 끝나면 잠깐 보여 주고 닫기
  useEffect(() => {
    if (phase !== 'done' || msg.warn) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [phase, msg.warn, onClose]);

  const ranked: Ranked[] = useMemo(() => {
    const d0 = dayOf(ev.date);
    return cands
      .map((o) => {
        const d = dayOf(o.dueDate) ?? dayOf(o.createdAt);
        return { o, sim: clientSim(o.clientCompanyName, ev.client), gap: d0 != null && d != null ? Math.round(Math.abs(d - d0) / DAY) : 99 };
      })
      .sort((a, b) => b.sim * 10 - b.gap * 0.6 - (b.o.hasEstimate ? 1 : 0) - (a.sim * 10 - a.gap * 0.6 - (a.o.hasEstimate ? 1 : 0)));
  }, [cands, ev.date, ev.client]);

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
    save([orderNoCore(picked.orderNumber)], picked);
  };

  const busy = phase === 'saving' || phase === 'auto' || phase === 'loading';

  return (
    <div className="efas" role="dialog" aria-modal="true" aria-label="이지폼 명세서 홈페이지 반영">
      <div className="efas-card">
        <header className="efas-head">
          <div>
            <p className="efas-kicker">
              이지폼에 저장한 명세서{ev.bizName ? ` · ${ev.bizName.replace(/\(\d{3}-\d{2}-\d{5}\)/, '')}` : ''}
              {more > 0 && <span className="efas-more">+{more}건 대기</span>}
            </p>
            <h2 className="efas-title">
              {phase === 'pick' ? '홈페이지 어느 지시서의 명세서인가요?' : phase === 'done' ? msg.main : phase === 'error' ? msg.main : '홈페이지에 반영하는 중…'}
            </h2>
          </div>
          <button type="button" className="efas-x" onClick={onClose} disabled={phase === 'saving'} aria-label="닫기">
            ✕
          </button>
        </header>

        <section className="efas-stmt" aria-label="이지폼 명세서">
          <div className="efas-stmt-meta">
            <span className="efas-client">{ev.client || '거래처 못 읽음'}</span>
            <span>{fmtDay(ev.date)} 발행</span>
            <b>{won(ev.total || sum)}</b>
            <span className="efas-mute">{grid.length}줄</span>
          </div>
          <div className="efas-rows">
            <table>
              <thead>
                <tr>
                  <th>품목</th>
                  <th>규격</th>
                  <th className="num">수량</th>
                  <th className="num">단가</th>
                </tr>
              </thead>
              <tbody>
                {grid.map((r, i) => (
                  <tr key={i}>
                    <td>{r.품목 || r.품목코드}</td>
                    <td>{r.규격}</td>
                    <td className="num">{r.수량}</td>
                    <td className="num">{r.단가 ? Number(r.단가.replace(/,/g, '')).toLocaleString('ko-KR') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {phase === 'pick' && (
          <section className="efas-pick">
            <div className="efas-tools">
              <span className="efas-hint">
                {clientKnown ? (
                  <>
                    <b>{ev.client}</b> · {fmtDay(ev.date)} 앞뒤 {days}일 지시서
                  </>
                ) : (
                  <>거래처가 같은 지시서를 못 찾아서 날짜 가까운 순으로 보여드려요</>
                )}
              </span>
              <input
                className="efas-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="거래처·주문번호로 찾기"
                aria-label="거래처나 주문번호로 지시서 찾기"
              />
            </div>
            {visible.length ? (
              <ul className="efas-grid">
                {visible.slice(0, 24).map(({ o, gap }) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      className={'efas-cand' + (picked?.id === o.id ? ' on' : '')}
                      onClick={() => setPicked(o)}
                      onDoubleClick={() => {
                        setPicked(o);
                        save([orderNoCore(o.orderNumber)], o);
                      }}
                      aria-pressed={picked?.id === o.id}
                    >
                      <div className="efas-thumb">
                        <WorksheetThumbnail pdfUrl={o.worksheetPdfUrl} thumbnailUrl={o.worksheetThumbnailUrl} rootMargin="300px 0px" />
                      </div>
                      <div className="efas-cand-body">
                        <span className="efas-cand-client">{o.clientCompanyName || '거래처 없음'}</span>
                        <span className="efas-cand-sub">
                          {orderNoCore(o.orderNumber)} · 납기 {fmtDay(o.dueDate) || '없음'}
                          {gap === 0 ? '' : ` (${gap}일 차이)`}
                        </span>
                        {o.title && <span className="efas-cand-title">{o.title}</span>}
                        <span className="efas-badges">
                          {o.hasEstimate && <i className="b-est">명세서 있음 → 덮어씀</i>}
                          {o.deletedAt && <i className="b-done">작업완료</i>}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="efas-empty">
                {q ? '찾는 지시서가 없어요.' : `${fmtDay(ev.date)} 앞뒤 ${days}일에 지시서가 없어요.`}
              </p>
            )}
            <div className="efas-wider">
              {!q && hiddenCount > 0 && (
                <button type="button" onClick={() => setShowAll(true)}>
                  다른 거래처 지시서도 보기 ({hiddenCount})
                </button>
              )}
              {days < 30 && (
                <button
                  type="button"
                  onClick={() => {
                    setDays(30);
                    setPhase('loading');
                  }}
                >
                  날짜 더 넓게(앞뒤 30일)
                </button>
              )}
            </div>
          </section>
        )}

        {(phase === 'done' || phase === 'error') && (
          <section className={'efas-result ' + phase}>
            <p className="efas-result-main">{phase === 'done' ? '✅ ' : '⚠ '}{msg.main}</p>
            {msg.sub && <p className="efas-result-sub">{msg.sub}</p>}
            {msg.warn && <p className="efas-result-warn">{msg.warn}</p>}
          </section>
        )}

        {busy && (
          <div className="efas-busy">
            {phase === 'loading' ? '지시서를 찾는 중…' : picked ? '이지폼 비고에 주문번호를 적고 홈페이지에 반영하는 중…' : '홈페이지에 반영하는 중…'}
          </div>
        )}

        <footer className="efas-foot">
          {phase === 'pick' ? (
            <>
              <button type="button" className="efas-btn ghost" onClick={onClose}>
                반영 안 함
              </button>
              <button type="button" className="efas-btn primary" disabled={!picked} onClick={confirm}>
                {picked ? `${orderNoCore(picked.orderNumber)} 지시서가 맞아요` : '지시서를 골라주세요'}
              </button>
            </>
          ) : (
            <>
              {phase === 'error' && cands.length > 0 && (
                <button type="button" className="efas-btn ghost" onClick={() => setPhase('pick')}>
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
