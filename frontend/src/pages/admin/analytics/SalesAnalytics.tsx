import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { salesAnalytics } from '../autoquote/annot/api';
import type { SalesAnalytics as SA, NameRevenue, Mover, ClientDetail } from '../autoquote/annot/api';
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

const SA_PASSCODE = '9512'; // 매출분석 2차 비밀번호(가림막 — 실제 보호는 admin 로그인/JWT)

export default function SalesAnalytics() {
  const { token } = useAuth();
  const [data, setData] = useState<SA | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const [range, setRange] = useState(24); // 월별 차트 기간(개월), 0 = 전체
  const [yoyOn, setYoyOn] = useState(true); // 월별 차트 전년동월 고스트 막대 on/off
  const [picked, setPicked] = useState<string | null>(null); // 드릴다운 모달 대상 거래처명
  // 연 목표 — PC별 localStorage(`sa-goal-<연도>`). 달성률 링에만 쓰는 가벼운 값.
  const [goal, setGoal] = useState<number | null>(null);
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  // 2차 비밀번호 잠금 — 세션 동안 1회만(세션스토리지). 실매출이라 옆사람 가림막.
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('sa-unlocked') === '1');
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState(false);

  useEffect(() => {
    if (!unlocked) return;
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
  }, [token, unlocked]);

  // 데이터가 오면 그 해의 연 목표(localStorage)를 불러온다.
  useEffect(() => {
    if (!data) return;
    const v = localStorage.getItem(`sa-goal-${data.yearPace.year}`);
    setGoal(v ? Number(v) : null);
  }, [data]);

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
  const { concentration, churnRisk, newClientsByYear, segments, yearPace, movers, clientDetails } = data;

  // 전년동월 매출 조회용 맵 ('2026.06' → 매출). YoY 고스트 막대·히어로 동월비교에 사용.
  const ymRev = new Map(monthly.map((m) => [m.ym, m.revenue]));
  const prevYearYm = (ym: string): string => `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`; // .06 유지
  const latestPrevYoy = (() => {
    const py = ymRev.get(prevYearYm(summary.latestYm));
    if (py == null || py <= 0) return null;
    return Math.round(((summary.latestRevenue - py) / py) * 1000) / 10;
  })();

  // 올해 페이스 — 목표 달성률(누적 기준) + 예상 달성률.
  const goalPct = goal && goal > 0 ? Math.round((yearPace.ytdRevenue / goal) * 100) : null;
  const goalProjPct = goal && goal > 0 ? Math.round((yearPace.projectedRevenue / goal) * 100) : null;
  const goalRemain = goal && goal > 0 ? Math.max(0, goal - yearPace.ytdRevenue) : 0;
  const saveGoal = () => {
    const v = Math.round(Number(goalInput.replace(/[^\d]/g, '')) || 0);
    if (v > 0) {
      localStorage.setItem(`sa-goal-${yearPace.year}`, String(v));
      setGoal(v);
    } else {
      localStorage.removeItem(`sa-goal-${yearPace.year}`);
      setGoal(null);
    }
    setGoalEditing(false);
  };
  const openClient = (name: string) => {
    if (clientDetails[name]) setPicked(name);
  };

  const maxNew = Math.max(...newClientsByYear.map((n) => n.newClients), 1);
  // 집중도 위험도 — HHI 표준(>2500 높음, 1500~2500 보통, <1500 낮음)
  const riskLevel = concentration.hhi >= 2500 ? '높음' : concentration.hhi >= 1500 ? '보통' : '낮음';
  const riskClass = concentration.hhi >= 2500 ? 'hi' : concentration.hhi >= 1500 ? 'mid' : 'lo';
  const SEG_COLOR: Record<string, string> = {
    '우수(VIP)': '#0a9396',
    '일반(활성)': '#5a73a8',
    신규: '#4f8a5b',
    '이탈위험·휴면': '#c06a52',
  };
  const months = range === 0 ? monthly : monthly.slice(-range);
  const maxMonth = Math.max(...months.map((m) => m.revenue), 1);
  const maxYear = Math.max(...yearly.map((y) => y.revenue), 1);
  const maxSeason = Math.max(...seasonality.map((s) => s.revenue), 1);
  const seasonMaxMonth = seasonality.reduce((a, b) => (b.revenue > a.revenue ? b : a), seasonality[0]);

  // 자연어 인사이트 (뱅크샐러드 감성)
  const prevMonth = monthly.length >= 2 ? monthly[monthly.length - 2] : null;
  const momDiff = prevMonth ? summary.latestRevenue - prevMonth.revenue : 0;
  const momSay =
    summary.momPct == null
      ? '이번 달 첫 매출이에요.'
      : momDiff >= 0
        ? `지난달보다 ${won(Math.abs(momDiff))}원 더 벌었어요`
        : `지난달보다 ${won(Math.abs(momDiff))}원 줄었어요`;
  const matTotal = materials.reduce((s, m) => s + m.revenue, 0) || 1;
  const topMat = materials[0];
  const bestMonth = monthly.reduce((a, b) => (b.revenue > a.revenue ? b : a), monthly[0]);
  const topClient = topClients[0];

  const seg = [
    { k: 12, l: '12개월' },
    { k: 24, l: '24개월' },
    { k: 0, l: '전체' },
  ];

  return (
    <div className="sa-shell">
      <div className="sa-title">
        <h1>매출분석</h1>
        <span>
          상세 명세서 {summary.totalInvoices.toLocaleString()}건 · {summary.firstYm}~{summary.lastYm}
        </span>
      </div>

      {/* 히어로 — 최근 달 매출 + 자연어 인사이트 */}
      <div className="sa-hero">
        <div className="sa-hero-top">
          <span className="sa-hero-label">{summary.latestYm} 매출</span>
          {summary.momPct != null && (
            <span className={'sa-hero-pill ' + (summary.momPct >= 0 ? 'up' : 'down')}>
              {summary.momPct >= 0 ? '▲' : '▼'} {Math.abs(summary.momPct)}%
            </span>
          )}
        </div>
        <div className="sa-hero-num">{wonFull(summary.latestRevenue)}</div>
        <div className="sa-hero-say">{momSay}</div>
        {latestPrevYoy != null && (
          <div className="sa-hero-yoy">
            작년 {prevYearYm(summary.latestYm)}({won(ymRev.get(prevYearYm(summary.latestYm)) || 0)}원) 대비{' '}
            <b className={latestPrevYoy >= 0 ? 'up' : 'down'}>
              {latestPrevYoy >= 0 ? '▲' : '▼'} {Math.abs(latestPrevYoy)}%
            </b>
          </div>
        )}
      </div>

      {/* 올해 페이스 — 예상 연매출(run-rate) + 목표 달성률 링 */}
      <div className="sa-pace">
        <div className="sa-pace-main">
          <div className="sa-pace-head">
            <span className="sa-pace-label">{yearPace.year}년 예상 매출</span>
            {yearPace.projectedYoyPct != null && (
              <span className={'sa-hero-pill ' + (yearPace.projectedYoyPct >= 0 ? 'up' : 'down')}>
                {yearPace.projectedYoyPct >= 0 ? '▲' : '▼'} {Math.abs(yearPace.projectedYoyPct)}%
              </span>
            )}
          </div>
          <div className="sa-pace-num">{wonFull(yearPace.projectedRevenue)}</div>
          <div className="sa-pace-sub">
            {yearPace.throughMonth}월까지 누적 <b>{won(yearPace.ytdRevenue)}원</b>
            {yearPace.ytdYoyPct != null && (
              <>
                {' '}· 작년 동기간({won(yearPace.lastYearYtd)}원) 대비{' '}
                <b className={yearPace.ytdYoyPct >= 0 ? 'pos' : 'neg'}>
                  {yearPace.ytdYoyPct >= 0 ? '+' : ''}
                  {yearPace.ytdYoyPct}%
                </b>
              </>
            )}
          </div>
          {yearPace.lastYearFull > 0 && (
            <div className="sa-pace-note">작년 전체 {won(yearPace.lastYearFull)}원 · 작년 패턴 기반 투영</div>
          )}
        </div>

        <div className="sa-pace-goal">
          {goal && goal > 0 ? (
            <>
              <GoalRing pct={goalPct || 0} />
              <div className="sa-goal-meta">
                <div className="sa-goal-line">
                  목표 <b>{won(goal)}원</b>
                </div>
                <div className="sa-goal-line dim">
                  {goalRemain > 0 ? `남은 ${won(goalRemain)}원` : '목표 달성! 🎉'}
                  {goalProjPct != null && ` · 예상 ${goalProjPct}%`}
                </div>
                <button className="sa-goal-edit" onClick={() => { setGoalInput(String(goal)); setGoalEditing(true); }}>
                  목표 수정
                </button>
              </div>
            </>
          ) : goalEditing ? (
            <div className="sa-goal-edit-box">
              <label>연 목표 매출(원)</label>
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveGoal()}
                placeholder="예: 500000000"
              />
              <div className="sa-goal-btns">
                <button className="primary" onClick={saveGoal}>저장</button>
                <button onClick={() => setGoalEditing(false)}>취소</button>
              </div>
            </div>
          ) : (
            <button className="sa-goal-set" onClick={() => { setGoalInput(''); setGoalEditing(true); }}>
              <span className="sa-goal-plus">＋</span>
              {yearPace.year}년 목표 설정
            </button>
          )}
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="sa-cards">
        <Card label="총 매출" value={`${won(summary.totalRevenue)}원`} sub={`${summary.firstYm}~${summary.lastYm}`} />
        <Card label="총 명세서" value={`${summary.totalInvoices.toLocaleString()}건`} />
        <Card label="평균 명세서 금액" value={`${won(summary.avgInvoice)}원`} />
        <Card label="거래처 수" value={`${summary.clientCount.toLocaleString()}곳`} />
      </div>

      {/* 인사이트 칩 */}
      <div className="sa-insights">
        {topClient && (
          <div className="sa-ins">
            <span className="sa-ins-ico">🏆</span>
            <div>
              <div className="sa-ins-k">최다 매출 거래처</div>
              <div className="sa-ins-v">
                {topClient.name} <em>{won(topClient.revenue)}원</em>
              </div>
            </div>
          </div>
        )}
        {topMat && (
          <div className="sa-ins">
            <span className="sa-ins-ico">🧱</span>
            <div>
              <div className="sa-ins-k">주력 자재</div>
              <div className="sa-ins-v">
                {topMat.name} <em>{Math.round((topMat.revenue / matTotal) * 100)}%</em>
              </div>
            </div>
          </div>
        )}
        {bestMonth && (
          <div className="sa-ins">
            <span className="sa-ins-ico">📅</span>
            <div>
              <div className="sa-ins-k">최고 매출의 달</div>
              <div className="sa-ins-v">
                {bestMonth.ym} <em>{won(bestMonth.revenue)}원</em>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 월별 매출 추이 + 기간 토글 */}
      <Section
        title="월별 매출 추이"
        right={
          <div className="sa-section-right-row">
            <button
              className={'sa-yoy-toggle' + (yoyOn ? ' on' : '')}
              onClick={() => setYoyOn((v) => !v)}
              title="전년 동월 매출을 옅은 막대로 겹쳐 보기"
            >
              전년동월
            </button>
            <div className="sa-seg">
              {seg.map((o) => (
                <button key={o.k} className={range === o.k ? 'on' : ''} onClick={() => setRange(o.k)}>
                  {o.l}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="sa-bars">
          {months.map((m, i) => {
            const mo = m.ym.slice(5);
            const sparse = months.length > 18;
            const showX = sparse ? ['01', '04', '07', '10'].includes(mo) : true;
            const latest = i === months.length - 1;
            const prev = ymRev.get(prevYearYm(m.ym)); // 전년 동월 매출
            const yoy = prev && prev > 0 ? Math.round(((m.revenue - prev) / prev) * 100) : null;
            const tip =
              `${m.ym} · ${wonFull(m.revenue)} · ${m.invoices}건` +
              (prev != null ? ` · 전년동월 ${wonFull(prev)}${yoy != null ? ` (${yoy >= 0 ? '+' : ''}${yoy}%)` : ''}` : '');
            return (
              <div className="sa-bar-col" key={m.ym} title={tip}>
                <div className="sa-bar-stack">
                  {yoyOn && prev != null && prev > 0 && (
                    <div className="sa-bar-ghost" style={{ height: `${Math.max(2, (prev / maxMonth) * 100)}%` }} />
                  )}
                  <div
                    className={'sa-bar' + (latest ? ' on' : '')}
                    style={{ height: `${Math.max(3, (m.revenue / maxMonth) * 100)}%` }}
                  />
                </div>
                <div className="sa-bar-x">{showX ? ymShort(m.ym) : ''}</div>
              </div>
            );
          })}
        </div>
        {yoyOn && (
          <div className="sa-bars-legend">
            <span><i className="lg-now" /> 올해</span>
            <span><i className="lg-prev" /> 전년 동월</span>
          </div>
        )}
      </Section>

      {/* 거래처 무버스 — 올해 누적 vs 작년 동기간 급상승·급감 */}
      <Section title="거래처 무버스" sub={movers.basis || '올해 vs 작년 동기간'}>
        {movers.risers.length === 0 && movers.fallers.length === 0 ? (
          <div className="sa-churn-none">비교할 작년 동기간 데이터가 아직 없어요.</div>
        ) : (
          <div className="sa-movers">
            <div className="sa-mov-col">
              <div className="sa-mov-head up">📈 급상승 · 신규</div>
              {movers.risers.map((m) => (
                <MoverRow key={m.name} m={m} dir="up" onPick={openClient} hasDetail={!!clientDetails[m.name]} />
              ))}
              {movers.risers.length === 0 && <div className="sa-mov-empty">해당 없음</div>}
            </div>
            <div className="sa-mov-col">
              <div className="sa-mov-head down">📉 급감 · 이탈</div>
              {movers.fallers.map((m) => (
                <MoverRow key={m.name} m={m} dir="down" onPick={openClient} hasDetail={!!clientDetails[m.name]} />
              ))}
              {movers.fallers.length === 0 && <div className="sa-mov-empty">해당 없음</div>}
            </div>
          </div>
        )}
      </Section>

      <div className="sa-grid">
        {/* 연도별 매출 */}
        <Section
          title="연도별 매출"
          sub={summary.yoyPct != null ? `전년대비 ${summary.yoyPct >= 0 ? '▲' : '▼'} ${Math.abs(summary.yoyPct)}%` : ''}
        >
          <div className="sa-ybars">
            {yearly.map((y, i) => (
              <div className="sa-ybar-col" key={y.year} title={`${y.year} · ${wonFull(y.revenue)} · ${y.invoices}건`}>
                <div className="sa-ybar-val">{won(y.revenue)}</div>
                <div
                  className={'sa-ybar' + (i === yearly.length - 1 ? ' on' : '')}
                  style={{ height: `${Math.max(6, (y.revenue / maxYear) * 100)}%` }}
                />
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
                <div
                  className={'sa-bar' + (s.month === seasonMaxMonth.month ? ' on' : ' mute')}
                  style={{ height: `${Math.max(3, (s.revenue / maxSeason) * 100)}%` }}
                />
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
        <Section title="거래처 매출 TOP 15" sub="공급가액 기준 · 탭하면 상세">
          <RankList
            rows={topClients.map((c) => ({ name: c.name, revenue: c.revenue, sub: `${c.count}건` }))}
            onPick={openClient}
          />
        </Section>
      </div>

      {/* 품목 TOP */}
      <Section title="품목코드 매출 TOP 15" sub="라인(수량×단가) 기준">
        <RankList rows={topItems.map((t) => ({ name: t.name, revenue: t.revenue, sub: `${t.count}건` }))} />
      </Section>

      <div className="sa-divider">거래처 인사이트</div>

      {/* 거래처 집중도 리스크 (파레토/HHI) */}
      <Section
        title="거래처 집중도 리스크"
        sub="특정 거래처 의존도 — 높을수록 위험"
        right={<span className={'sa-risk ' + riskClass}>위험도 {riskLevel}</span>}
      >
        <div className="sa-conc-bar">
          <span className="s1" style={{ width: `${concentration.top1Pct}%` }} title={`1위 ${concentration.top1Pct}%`} />
          <span
            className="s2"
            style={{ width: `${Math.max(0, concentration.top5Pct - concentration.top1Pct)}%` }}
            title={`2~5위`}
          />
          <span
            className="s3"
            style={{ width: `${Math.max(0, concentration.top10Pct - concentration.top5Pct)}%` }}
            title={`6~10위`}
          />
          <span className="s4" style={{ width: `${Math.max(0, 100 - concentration.top10Pct)}%` }} title="나머지" />
        </div>
        <div className="sa-conc-stats">
          <div>
            <b>{concentration.top1Pct}%</b>
            <span>1위 거래처</span>
          </div>
          <div>
            <b>{concentration.top5Pct}%</b>
            <span>상위 5개</span>
          </div>
          <div>
            <b>{concentration.top10Pct}%</b>
            <span>상위 10개</span>
          </div>
          <div>
            <b>{concentration.hhi.toLocaleString()}</b>
            <span>HHI 지수</span>
          </div>
        </div>
        <div className="sa-conc-say">
          상위 <b>{concentration.pareto80Count}개</b>({concentration.pareto80Pct}%) 거래처가 전체 매출의 80%를 차지해요.
        </div>
      </Section>

      <div className="sa-grid">
        {/* 거래처 세그먼트 (RFM) */}
        <Section title="거래처 세그먼트" sub="최근성·거래량·매출 기준">
          <div className="sa-segs">
            {segments.map((s) => (
              <div className="sa-seg-card" key={s.name} style={{ borderColor: SEG_COLOR[s.name] || '#d7dde3' }}>
                <div className="sa-seg-name" style={{ color: SEG_COLOR[s.name] || '#1f2733' }}>
                  {s.name}
                </div>
                <div className="sa-seg-n">{s.clients.toLocaleString()}곳</div>
                <div className="sa-seg-rev">{won(s.revenue)}원</div>
              </div>
            ))}
          </div>
        </Section>

        {/* 신규 거래처 */}
        <Section title="신규 거래처" sub="연도별 첫 거래">
          <div className="sa-ybars">
            {newClientsByYear.map((n) => (
              <div className="sa-ybar-col" key={n.year} title={`${n.year} · 신규 ${n.newClients}곳`}>
                <div className="sa-ybar-val">{n.newClients}</div>
                <div className="sa-ybar" style={{ height: `${Math.max(6, (n.newClients / maxNew) * 100)}%` }} />
                <div className="sa-ybar-x">{n.year}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* 이탈 위험 거래처 (silent churn) */}
      <Section title="이탈 위험 거래처" sub="한동안 거래가 없는 단골 — 탭하면 상세, 연락해보세요">
        {churnRisk.length === 0 ? (
          <div className="sa-churn-none">이탈 위험 거래처가 없어요 👍</div>
        ) : (
          <div className="sa-churn">
            {churnRisk.map((c) => {
              const has = !!clientDetails[c.name];
              return (
                <div
                  className={'sa-churn-row' + (has ? ' clickable' : '')}
                  key={c.name}
                  onClick={() => has && openClient(c.name)}
                  role={has ? 'button' : undefined}
                  tabIndex={has ? 0 : undefined}
                >
                  <span className="sa-churn-name" title={c.name}>
                    {c.name}
                  </span>
                  <span className="sa-churn-meta">
                    마지막 {c.lastYm} · <b>{c.inactiveMonths}개월째</b> 거래 없음 · 누적 {c.orders}회
                  </span>
                  <span className="sa-churn-rev">{won(c.revenue)}원</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <div className="sa-foot">매출 = 명세서 공급가액(VAT 제외) · 상세 명세서 데이터 기반</div>

      {picked && clientDetails[picked] && (
        <ClientModal detail={clientDetails[picked]} onClose={() => setPicked(null)} />
      )}
    </div>
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
        >
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

// 목표 달성률 링(SVG 도넛). pct는 0~ (100 초과 가능, 링은 100%에서 채움 멈춤).
function GoalRing({ pct }: { pct: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const filled = Math.min(100, Math.max(0, pct));
  const done = pct >= 100;
  return (
    <svg viewBox="0 0 120 120" className="sa-ring" role="img" aria-label={`목표 달성률 ${pct}%`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#e2eceb" strokeWidth="13" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke={done ? '#1f8a4c' : '#0a9396'}
        strokeWidth="13"
        strokeLinecap="round"
        strokeDasharray={`${(filled / 100) * c} ${c}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="56" textAnchor="middle" className="sa-ring-pct">
        {pct}%
      </text>
      <text x="60" y="74" textAnchor="middle" className="sa-ring-sub">
        달성
      </text>
    </svg>
  );
}

// 무버 한 줄 — 거래처명 + 증감액(▲/▼) + 올해/작년 동기간 보조.
function MoverRow({
  m,
  dir,
  onPick,
  hasDetail,
}: {
  m: Mover;
  dir: 'up' | 'down';
  onPick: (name: string) => void;
  hasDetail: boolean;
}) {
  const isNew = m.previous === 0; // 작년 동기간 거래 없음 = 신규
  const isLost = m.current === 0; // 올해 거래 없음 = 끊김
  return (
    <div
      className={'sa-mov-row' + (hasDetail ? ' clickable' : '')}
      onClick={() => hasDetail && onPick(m.name)}
      role={hasDetail ? 'button' : undefined}
      tabIndex={hasDetail ? 0 : undefined}
    >
      <span className="sa-mov-name" title={m.name}>
        {m.name}
        {isNew && <em className="sa-tag new">신규</em>}
        {isLost && <em className="sa-tag lost">끊김</em>}
      </span>
      <span className="sa-mov-sub">
        {won(m.current)} <span className="sa-mov-arr">←</span> {won(m.previous)}
      </span>
      <span className={'sa-mov-delta ' + dir}>
        {dir === 'up' ? '▲' : '▼'} {won(Math.abs(m.delta))}
      </span>
    </div>
  );
}

const SEG_BADGE: Record<string, string> = {
  '우수(VIP)': '#0a9396',
  '일반(활성)': '#5a73a8',
  신규: '#4f8a5b',
  '이탈위험·휴면': '#c06a52',
};

// 거래처 드릴다운 모달 — 월별 추이 + 주력 품목 + 메타.
function ClientModal({ detail, onClose }: { detail: ClientDetail; onClose: () => void }) {
  const months = detail.monthly;
  const maxM = Math.max(...months.map((m) => m.revenue), 1);
  const sparse = months.length > 18;
  const segColor = SEG_BADGE[detail.segment] || '#9aa5b1';
  return (
    <div className="sa-modal-overlay" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <button className="sa-modal-x" onClick={onClose} aria-label="닫기">
          ✕
        </button>
        <div className="sa-modal-head">
          <h3 title={detail.name}>{detail.name}</h3>
          {detail.segment && (
            <span className="sa-modal-seg" style={{ background: segColor }}>
              {detail.segment}
            </span>
          )}
        </div>
        <div className="sa-modal-stats">
          <div>
            <b>{won(detail.totalRevenue)}원</b>
            <span>누적 매출</span>
          </div>
          <div>
            <b>{detail.orderCount.toLocaleString()}건</b>
            <span>거래 횟수</span>
          </div>
          <div>
            <b>{detail.lastYm || '-'}</b>
            <span>{detail.inactiveMonths > 0 ? `${detail.inactiveMonths}개월 전` : '최근 거래'}</span>
          </div>
          <div>
            <b>{detail.firstYm || '-'}</b>
            <span>첫 거래</span>
          </div>
        </div>

        <div className="sa-modal-sect">월별 매출 추이</div>
        {months.length === 0 ? (
          <div className="sa-modal-empty">월별 데이터 없음</div>
        ) : (
          <div className="sa-bars modal">
            {months.map((m, i) => {
              const mo = m.ym.slice(5);
              const showX = sparse ? ['01', '07'].includes(mo) || i === months.length - 1 : true;
              return (
                <div className="sa-bar-col" key={m.ym} title={`${m.ym} · ${wonFull(m.revenue)} · ${m.count}건`}>
                  <div
                    className={'sa-bar' + (i === months.length - 1 ? ' on' : '')}
                    style={{ height: `${Math.max(3, (m.revenue / maxM) * 100)}%` }}
                  />
                  <div className="sa-bar-x">{showX ? ymShort(m.ym) : ''}</div>
                </div>
              );
            })}
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
