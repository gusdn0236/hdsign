import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { salesAnalytics, refreshSalesAnalytics } from '../autoquote/annot/api';
import type { SalesAnalytics as SA, SalesPoint, NameRevenue, ClientDetail } from '../autoquote/annot/api';
import './SalesAnalytics.css';

// 매출분석 — 홈페이지에서 이지폼 입력까지 끝낸 명세서만 모아 보여준다(2026-11-24 새로 만듦).
// 서버가 30분마다 자동 재집계하고, 화면도 열려 있는 동안 5분마다 새 값을 받아온다.

// ---- 포맷 ----
const won = (v: number): string => {
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return Math.round(v).toLocaleString();
};
const wonFull = (v: number): string => `${Math.round(v).toLocaleString()}원`;
const md = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`; // 2026-11-04 → 11/4
const dot = (d: string | null): string => (d ? d.replace(/-/g, '.') : '-'); // 2026-11-04 → 2026.11.04
const ymLabel = (ym: string): string => `${ym.slice(2, 4)}.${ym.slice(5, 7)}`; // 2026-11 → 26.11
const hhmm = (iso: string): string => iso.slice(11, 16);
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const weekday = (d: string): string => WEEKDAY[new Date(`${d}T00:00:00`).getDay()];

const COLORS = ['#0a9396', '#4f8a5b', '#b07d3a', '#8a5a7d', '#c06a52', '#5a73a8', '#6b8e4e', '#d39a4e', '#9aa5b1'];

const SA_PASSCODE = '9512'; // 매출분석 2차 비밀번호(가림막 — 실제 보호는 admin 로그인/JWT)
const POLL_MS = 5 * 60 * 1000; // 화면이 열려 있는 동안 서버 캐시를 다시 받아오는 주기

type ChartMode = 'day' | 'week' | 'month';

export default function SalesAnalytics() {
  const { token } = useAuth();
  const [data, setData] = useState<SA | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [mode, setMode] = useState<ChartMode>('day');
  const [clientScope, setClientScope] = useState<'month' | 'all'>('month');
  const [picked, setPicked] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 2차 비밀번호 잠금 — 세션 동안 1회만(세션스토리지). 실매출이라 옆사람 가림막.
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('sa-unlocked') === '1');
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState(false);

  useEffect(() => {
    if (!unlocked) return;
    let alive = true;
    const load = () =>
      salesAnalytics(token)
        .then((d) => {
          if (!alive || !d) return;
          setData(d);
          setState('ok');
        })
        .catch(() => alive && setState((s) => (s === 'ok' ? s : 'error')));
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [token, unlocked]);

  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    refreshSalesAnalytics(token)
      .then((d) => {
        if (d) {
          setData(d);
          setState('ok');
        }
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  if (!unlocked) {
    const submit = () => {
      if (pw === SA_PASSCODE) {
        sessionStorage.setItem('sa-unlocked', '1');
        setUnlocked(true);
        setPwErr(false);
      } else {
        setPwErr(true);
      }
    };
    return (
      <div className="sa-shell">
        <div className="sa-gate">
          <div className="sa-gate-box">
            <div className="sa-gate-ico">🔒</div>
            <h2>매출분석 잠금</h2>
            <p>실제 매출 데이터입니다. 2차 비밀번호를 입력하세요.</p>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setPwErr(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="비밀번호"
              className={pwErr ? 'err' : ''}
            />
            {pwErr && <div className="sa-gate-err">비밀번호가 올바르지 않습니다.</div>}
            <button type="button" onClick={submit}>
              확인
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state !== 'ok' || !data) {
    return (
      <div className="sa-shell">
        <div className="sa-load">{state === 'loading' ? '매출 데이터를 모으는 중…' : '매출분석을 불러오지 못했습니다.'}</div>
      </div>
    );
  }

  const { summary, thisMonth: tm, topClients, topClientsMonth, topItems, materials, recent } = data;
  const clientDetails = data.clientDetails ?? {};
  const openClient = (name: string) => {
    if (clientDetails[name]) setPicked(name);
  };

  const header = (
    <div className="sa-title">
      <h1>매출분석</h1>
      <span>
        홈페이지 명세서 {summary.invoices.toLocaleString()}건
        {summary.firstDate ? ` · ${dot(summary.firstDate)}부터` : ''}
      </span>
      <span className="sa-updated">
        {hhmm(data.updatedAt)} 업데이트 · {data.refreshMinutes}분마다 자동
      </span>
      <button className="sa-refresh" onClick={refresh} disabled={refreshing} title="30분을 기다리지 않고 지금 다시 모으기">
        {refreshing ? '모으는 중…' : '↻ 지금 업데이트'}
      </button>
    </div>
  );

  if (summary.invoices === 0) {
    return (
      <div className="sa-shell">
        {header}
        <div className="sa-empty">
          <div className="sa-empty-ico">📭</div>
          <b>아직 집계할 명세서가 없어요</b>
          <p>
            홈페이지에서 명세서를 작성하고 <b>이지폼 입력까지 끝내면</b>(카드에 완료 표시) 여기에 자동으로 쌓입니다.
          </p>
        </div>
      </div>
    );
  }

  const pill = tm.vsPrevPct;
  const diff = tm.revenue - tm.prevSamePeriod;
  const say =
    tm.prevSamePeriod <= 0
      ? '지난달 같은 기간 기록이 없어 비교는 다음 달부터 돼요.'
      : diff >= 0
        ? `지난달 같은 기간보다 ${won(Math.abs(diff))}원 더 많아요`
        : `지난달 같은 기간보다 ${won(Math.abs(diff))}원 적어요`;

  const clientRows = clientScope === 'month' ? topClientsMonth : topClients;

  return (
    <div className="sa-shell">
      {header}

      {/* 히어로 — 이번 달(1일~오늘) 매출 + 지난달 같은 기간 비교 */}
      <div className="sa-hero">
        <div className="sa-hero-top">
          <span className="sa-hero-label">
            {Number(tm.ym.slice(5, 7))}월 매출 <em className="sa-hero-range">1~{tm.throughDay}일</em>
          </span>
          {pill != null && (
            <span className={'sa-hero-pill ' + (pill >= 0 ? 'up' : 'down')}>
              {pill >= 0 ? '▲' : '▼'} {Math.abs(pill)}%
            </span>
          )}
        </div>
        <div className="sa-hero-num">{wonFull(tm.revenue)}</div>
        <div className="sa-hero-say">
          {say} · 명세서 {tm.invoices}건
        </div>
        <div className="sa-hero-yoy">
          지난달 1~{tm.throughDay}일 {won(tm.prevSamePeriod)}원 · 지난달 전체 {won(tm.prevMonthFull)}원
        </div>
        <div className="sa-hero-mini">
          <div>
            <span>오늘</span>
            <b>{won(tm.todayRevenue)}원</b>
            <em>{tm.todayInvoices}건</em>
          </div>
          <div>
            <span>이번 주</span>
            <b>{won(tm.weekRevenue)}원</b>
            <em>월요일부터</em>
          </div>
        </div>
      </div>

      {/* 요약 카드 — 집계 시작일부터 누적 */}
      <div className="sa-cards">
        <Card label="누적 매출" value={`${won(summary.totalRevenue)}원`} sub={`${dot(summary.firstDate)}~`} />
        <Card label="완료 명세서" value={`${summary.invoices.toLocaleString()}건`} />
        <Card label="평균 명세서 금액" value={`${won(summary.avgInvoice)}원`} />
        <Card label="거래처 수" value={`${summary.clientCount.toLocaleString()}곳`} />
      </div>

      {/* 매출 추이 — 일별(30일)/주별/월별 */}
      <Section
        title="매출 추이"
        right={
          <div className="sa-seg">
            {(
              [
                ['day', '일별'],
                ['week', '주별'],
                ['month', '월별'],
              ] as [ChartMode, string][]
            ).map(([k, l]) => (
              <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        <TrendChart mode={mode} data={data} />
      </Section>

      <div className="sa-grid">
        {/* 거래처 TOP */}
        <Section
          title="거래처 매출 TOP"
          sub="탭하면 상세"
          right={
            <div className="sa-seg">
              <button className={clientScope === 'month' ? 'on' : ''} onClick={() => setClientScope('month')}>
                이번 달
              </button>
              <button className={clientScope === 'all' ? 'on' : ''} onClick={() => setClientScope('all')}>
                전체
              </button>
            </div>
          }
        >
          {clientRows.length === 0 ? (
            <div className="sa-churn-none">이번 달 완료된 명세서가 아직 없어요.</div>
          ) : (
            <RankList
              rows={clientRows.map((c) => ({ name: c.name, revenue: c.revenue, sub: `${c.count}건` }))}
              onPick={openClient}
            />
          )}
        </Section>

        {/* 자재별 비중 */}
        <Section title="자재별 매출 비중" sub="명세서 줄 기준 · 전체 기간">
          {materials.length === 0 ? (
            <div className="sa-churn-none">품목 데이터가 없어요.</div>
          ) : (
            <Donut data={foldOther(materials, 8)} />
          )}
        </Section>
      </div>

      {/* 품목 TOP */}
      <Section title="품목 매출 TOP 15" sub="줄(수량×단가) 기준 · 전체 기간">
        <RankList rows={topItems.map((t) => ({ name: t.name, revenue: t.revenue, sub: `${t.count}건` }))} />
      </Section>

      {/* 최근 완료 명세서 — 새로 올라온 게 제대로 잡혔는지 확인용 */}
      <Section title="최근 완료된 명세서" sub={`최근 ${recent.length}건 · 발행일 순`}>
        <div className="sa-recent">
          {recent.map((r) => {
            const has = !!clientDetails[r.client];
            return (
              <div
                className={'sa-recent-row' + (has ? ' clickable' : '')}
                key={r.orderId}
                onClick={() => has && openClient(r.client)}
                role={has ? 'button' : undefined}
                tabIndex={has ? 0 : undefined}
              >
                <span className="sa-recent-date">
                  {md(r.date)} <em>({weekday(r.date)})</em>
                </span>
                <span className="sa-recent-client" title={r.client}>
                  {r.client}
                </span>
                <span className="sa-recent-no">{r.orderNumber}</span>
                <span className="sa-recent-rev">{wonFull(r.revenue)}</span>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="sa-foot">
        매출 = 명세서 합계(VAT 제외) · 홈페이지에서 작성하고 이지폼 입력까지 끝낸(완료) 명세서만 · 날짜 = 이지폼 발행일 ·
        임시저장·휴지통 주문은 빠져요
      </div>

      {picked && clientDetails[picked] && <ClientModal detail={clientDetails[picked]} onClose={() => setPicked(null)} />}
    </div>
  );
}

/** 자재 9개 넘으면 나머지를 '그 외'로 묶는다(색 9개 안에서). */
function foldOther(rows: NameRevenue[], keep: number): NameRevenue[] {
  if (rows.length <= keep + 1) return rows;
  const rest = rows.slice(keep).reduce((s, r) => s + r.revenue, 0);
  return [...rows.slice(0, keep), { name: '그 외', revenue: rest, count: 0 }];
}

// 매출 추이 막대 — 일별 최근 30일 / 주별 최근 16주 / 월별 전체. 마지막(진행 중) 막대 강조.
// 막대에 마우스를 올리면 위 읽기 줄에 그 기간 금액·건수가 뜬다(안 올리면 기간 합계).
function TrendChart({ mode, data }: { mode: ChartMode; data: SA }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts: SalesPoint[] =
    mode === 'day' ? data.daily.slice(-30) : mode === 'week' ? data.weekly.slice(-16) : data.monthly;
  const max = Math.max(...pts.map((p) => p.revenue), 1);
  const sum = pts.reduce((s, p) => s + p.revenue, 0);
  const cnt = pts.reduce((s, p) => s + p.invoices, 0);
  const label = (p: SalesPoint): string =>
    mode === 'day' ? `${md(p.key)}(${weekday(p.key)})` : mode === 'week' ? `${md(p.key)} 주` : `${ymLabel(p.key)}월`;
  const showX = (i: number): boolean => {
    if (mode === 'month') return pts.length <= 18 || i % 3 === 0 || i === pts.length - 1;
    if (mode === 'week') return i % 2 === 0 || i === pts.length - 1;
    return i % 5 === 0 || i === pts.length - 1;
  };
  const xText = (p: SalesPoint): string => (mode === 'month' ? ymLabel(p.key) : md(p.key));
  const h = hover != null ? pts[hover] : null;
  const rangeName = mode === 'day' ? `최근 ${pts.length}일` : mode === 'week' ? `최근 ${pts.length}주` : '전체 기간';
  return (
    <>
      <div className="sa-readout">
        {h ? (
          <>
            <span>{label(h)}</span>
            <b>{wonFull(h.revenue)}</b>
            <em>{h.invoices}건</em>
          </>
        ) : (
          <>
            <span>{rangeName} 합계</span>
            <b>{wonFull(sum)}</b>
            <em>{cnt}건</em>
          </>
        )}
      </div>
      <div className="sa-bars" onMouseLeave={() => setHover(null)}>
        {pts.map((p, i) => (
          <div
            className={'sa-bar-col' + (hover === i ? ' hov' : '')}
            key={p.key}
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(i)}
            title={`${label(p)} · ${wonFull(p.revenue)} · ${p.invoices}건`}
          >
            <div
              className={'sa-bar' + (i === pts.length - 1 ? ' on' : '') + (p.revenue === 0 ? ' zero' : '')}
              style={{ height: p.revenue === 0 ? '2px' : `${Math.max(3, (p.revenue / max) * 100)}%` }}
            />
            <div className="sa-bar-x">{showX(i) ? xText(p) : ''}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Section({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="sa-section">
      <div className="sa-section-head">
        <h3>{title}</h3>
        {sub && <span>{sub}</span>}
        {right && <div className="sa-section-right">{right}</div>}
      </div>
      {children}
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="sa-card">
      <div className="sa-card-label">{label}</div>
      <div className="sa-card-val">{value}</div>
      {sub && <div className="sa-card-sub">{sub}</div>}
    </div>
  );
}

function Donut({ data }: { data: NameRevenue[] }) {
  const total = data.reduce((s, d) => s + d.revenue, 0) || 1;
  const r = 60;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="sa-donut-wrap">
      <svg viewBox="0 0 160 160" className="sa-donut" role="img" aria-label="자재별 매출 비중">
        <g transform="rotate(-90 80 80)">
          {data.map((d, i) => {
            const len = (d.revenue / total) * c;
            const gap = data.length > 1 ? Math.min(2, len) : 0; // 조각 사이 2px 틈
            const seg = (
              <circle
                key={d.name}
                cx="80"
                cy="80"
                r={r}
                fill="none"
                stroke={COLORS[i % COLORS.length]}
                strokeWidth="22"
                strokeDasharray={`${len - gap} ${c - len + gap}`}
                strokeDashoffset={-acc}
              >
                <title>{`${d.name} · ${wonFull(d.revenue)} · ${Math.round((d.revenue / total) * 100)}%`}</title>
              </circle>
            );
            acc += len;
            return seg;
          })}
        </g>
        <text x="80" y="76" textAnchor="middle" className="sa-donut-c1">
          {won(total)}원
        </text>
        <text x="80" y="95" textAnchor="middle" className="sa-donut-c2">
          {data.length}개 자재
        </text>
      </svg>
      <div className="sa-legend">
        {data.map((d, i) => (
          <div className="sa-legend-row" key={d.name} title={wonFull(d.revenue)}>
            <span className="sa-legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="sa-legend-name">{d.name}</span>
            <span className="sa-legend-pct">{Math.round((d.revenue / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankList({
  rows,
  onPick,
}: {
  rows: { name: string; revenue: number; sub?: string }[];
  onPick?: (name: string) => void;
}) {
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  return (
    <div className="sa-rank">
      {rows.map((r, i) => (
        <div
          className={'sa-rank-row' + (onPick ? ' clickable' : '')}
          key={r.name + i}
          onClick={onPick ? () => onPick(r.name) : undefined}
          role={onPick ? 'button' : undefined}
          tabIndex={onPick ? 0 : undefined}
          title={`${r.name} · ${wonFull(r.revenue)}`}
        >
          <span className={'sa-rank-i' + (i < 3 ? ' top' : '')}>{i + 1}</span>
          <span className="sa-rank-name">{r.name}</span>
          <span className="sa-rank-bar-wrap">
            <span className="sa-rank-bar" style={{ width: `${(r.revenue / max) * 100}%` }} />
          </span>
          <span className="sa-rank-val">
            {won(r.revenue)}
            {r.sub ? <em> {r.sub}</em> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// 거래처 상세 모달 — 월별 추이 + 주력 품목 + 첫/마지막 거래일.
function ClientModal({ detail, onClose }: { detail: ClientDetail; onClose: () => void }) {
  const months = detail.monthly;
  const maxM = Math.max(...months.map((m) => m.revenue), 1);
  return (
    <div className="sa-modal-overlay" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <button className="sa-modal-x" onClick={onClose} aria-label="닫기">
          ✕
        </button>
        <div className="sa-modal-head">
          <h3 title={detail.name}>{detail.name}</h3>
        </div>
        <div className="sa-modal-stats">
          <div>
            <b>{won(detail.totalRevenue)}원</b>
            <span>누적 매출</span>
          </div>
          <div>
            <b>{detail.invoices.toLocaleString()}건</b>
            <span>명세서</span>
          </div>
          <div>
            <b>{dot(detail.lastDate)}</b>
            <span>마지막 거래</span>
          </div>
          <div>
            <b>{dot(detail.firstDate)}</b>
            <span>첫 거래</span>
          </div>
        </div>

        <div className="sa-modal-sect">월별 매출</div>
        {months.length === 0 ? (
          <div className="sa-modal-empty">월별 데이터 없음</div>
        ) : (
          <div className="sa-bars modal">
            {months.map((m, i) => (
              <div className="sa-bar-col" key={m.ym} title={`${ymLabel(m.ym)}월 · ${wonFull(m.revenue)} · ${m.count}건`}>
                <div
                  className={'sa-bar' + (i === months.length - 1 ? ' on' : '')}
                  style={{ height: `${Math.max(3, (m.revenue / maxM) * 100)}%` }}
                />
                <div className="sa-bar-x">{ymLabel(m.ym)}</div>
              </div>
            ))}
          </div>
        )}

        <div className="sa-modal-sect">주력 품목 TOP {detail.topItems.length}</div>
        {detail.topItems.length === 0 ? (
          <div className="sa-modal-empty">품목 데이터 없음</div>
        ) : (
          <RankList rows={detail.topItems.map((t) => ({ name: t.name, revenue: t.revenue, sub: `${t.count}건` }))} />
        )}
      </div>
    </div>
  );
}
