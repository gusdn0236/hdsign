import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { salesAnalytics } from '../autoquote/annot/api';
import type { SalesAnalytics as SA, NameRevenue } from '../autoquote/annot/api';
import './SalesAnalytics.css';

// ---- 포맷 ----
const won = (v: number): string => {
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return Math.round(v).toLocaleString();
};
const wonFull = (v: number): string => `${Math.round(v).toLocaleString()}원`;
const ymShort = (ym: string): string => `${ym.slice(2, 4)}.${ym.slice(5)}`; // 2024.03 → 24.03

const COLORS = ['#0a9396', '#4f8a5b', '#b07d3a', '#8a5a7d', '#c06a52', '#5a73a8', '#6b8e4e', '#d39a4e', '#9aa5b1', '#5fb0b2'];

export default function SalesAnalytics() {
  const { token } = useAuth();
  const [data, setData] = useState<SA | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    salesAnalytics(token)
      .then((d) => {
        if (!alive) return;
        if (!d) {
          setState('empty');
          return;
        }
        setData(d);
        setState('ok');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, [token]);

  if (state !== 'ok' || !data) {
    const msg =
      state === 'loading'
        ? '매출 데이터를 분석하는 중…'
        : state === 'empty'
          ? '명세서 데이터(코퍼스)가 서버에 아직 없습니다.'
          : '매출분석을 불러오지 못했습니다.';
    return (
      <div className="sa-shell">
        <div className="sa-load">{msg}</div>
      </div>
    );
  }

  const { summary, monthly, yearly, topClients, topItems, materials, seasonality } = data;
  const months = monthly.slice(-24);
  const maxMonth = Math.max(...months.map((m) => m.revenue), 1);
  const maxYear = Math.max(...yearly.map((y) => y.revenue), 1);
  const maxSeason = Math.max(...seasonality.map((s) => s.revenue), 1);

  return (
    <div className="sa-shell">
      <div className="sa-title">
        <h1>📊 매출분석</h1>
        <span>
          상세 명세서 {summary.totalInvoices.toLocaleString()}건 · {summary.firstYm}~{summary.lastYm}
        </span>
      </div>

      {/* 히어로 — 최근 달 매출 */}
      <div className="sa-hero">
        <div className="sa-hero-label">{summary.latestYm} 매출</div>
        <div className="sa-hero-num">{wonFull(summary.latestRevenue)}</div>
        {summary.momPct != null && (
          <div className={'sa-hero-mom ' + (summary.momPct >= 0 ? 'up' : 'down')}>
            전월대비 {summary.momPct >= 0 ? '▲' : '▼'} {Math.abs(summary.momPct)}%
          </div>
        )}
      </div>

      {/* 요약 카드 */}
      <div className="sa-cards">
        <Card label="총 매출" value={`${won(summary.totalRevenue)}원`} sub={`${summary.firstYm}~${summary.lastYm}`} />
        <Card label="총 명세서" value={`${summary.totalInvoices.toLocaleString()}건`} />
        <Card label="평균 명세서 금액" value={`${won(summary.avgInvoice)}원`} />
        <Card label="거래처 수" value={`${summary.clientCount.toLocaleString()}곳`} />
      </div>

      {/* 월별 매출 추이 */}
      <Section title="월별 매출 추이" sub="최근 24개월 · 공급가액">
        <div className="sa-bars">
          {months.map((m) => {
            const mo = m.ym.slice(5);
            const showX = ['01', '04', '07', '10'].includes(mo);
            return (
              <div className="sa-bar-col" key={m.ym} title={`${m.ym} · ${wonFull(m.revenue)} · ${m.invoices}건`}>
                <div className="sa-bar" style={{ height: `${Math.max(3, (m.revenue / maxMonth) * 100)}%` }} />
                <div className="sa-bar-x">{showX ? ymShort(m.ym) : ''}</div>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="sa-grid">
        {/* 연도별 매출 */}
        <Section
          title="연도별 매출"
          sub={summary.yoyPct != null ? `전년대비 ${summary.yoyPct >= 0 ? '▲' : '▼'} ${Math.abs(summary.yoyPct)}%` : ''}
        >
          <div className="sa-ybars">
            {yearly.map((y) => (
              <div className="sa-ybar-col" key={y.year} title={`${y.year} · ${wonFull(y.revenue)} · ${y.invoices}건`}>
                <div className="sa-ybar-val">{won(y.revenue)}</div>
                <div className="sa-ybar" style={{ height: `${Math.max(6, (y.revenue / maxYear) * 100)}%` }} />
                <div className="sa-ybar-x">{y.year}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* 계절성 */}
        <Section title="계절성" sub="달별 누적 매출(전 기간)">
          <div className="sa-bars season">
            {seasonality.map((s) => (
              <div className="sa-bar-col" key={s.month} title={`${s.month}월 · ${wonFull(s.revenue)}`}>
                <div className="sa-bar alt" style={{ height: `${Math.max(3, (s.revenue / maxSeason) * 100)}%` }} />
                <div className="sa-bar-x">{s.month}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <div className="sa-grid">
        {/* 자재별 비중 */}
        <Section title="자재별 매출 비중" sub="라인 기준">
          <Donut data={materials.slice(0, 9)} />
        </Section>

        {/* 거래처 TOP */}
        <Section title="거래처 매출 TOP 15" sub="공급가액 기준">
          <RankList rows={topClients.map((c) => ({ name: c.name, revenue: c.revenue, sub: `${c.count}건` }))} />
        </Section>
      </div>

      {/* 품목 TOP */}
      <Section title="품목코드 매출 TOP 15" sub="라인(수량×단가) 기준">
        <RankList rows={topItems.map((t) => ({ name: t.name, revenue: t.revenue, sub: `${t.count}건` }))} />
      </Section>

      <div className="sa-foot">매출 = 명세서 공급가액(VAT 제외). 상세 명세서 데이터 기반 집계.</div>
    </div>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sa-section">
      <div className="sa-section-head">
        <h3>{title}</h3>
        {sub && <span>{sub}</span>}
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
            const seg = (
              <circle
                key={d.name}
                cx="80"
                cy="80"
                r={r}
                fill="none"
                stroke={COLORS[i % COLORS.length]}
                strokeWidth="22"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
              />
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
          <div className="sa-legend-row" key={d.name}>
            <span className="sa-legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="sa-legend-name">{d.name}</span>
            <span className="sa-legend-pct">{Math.round((d.revenue / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankList({ rows }: { rows: { name: string; revenue: number; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  return (
    <div className="sa-rank">
      {rows.map((r, i) => (
        <div className="sa-rank-row" key={r.name + i}>
          <span className={'sa-rank-i' + (i < 3 ? ' top' : '')}>{i + 1}</span>
          <span className="sa-rank-name" title={r.name}>
            {r.name}
          </span>
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
