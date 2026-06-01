import { useEffect, useMemo, useRef, useState } from 'react';
// AuthContext 는 .jsx — 확장자 명시로 vite/vitest 모두 해석되게.
import { useAuth } from '../../../context/AuthContext.jsx';
import { estimate, computeTotals } from './engine';
import type {
  CorpusItem,
  EstimateResult,
  EvidenceRef,
  LineInput,
  Priors,
} from './engine';
import { loadAutoQuoteData } from './data/corpusClient';
import './AutoQuote.css';

/**
 * HD사인 자동견적 — Slice 1: 탭 + 수동 입력 견적엔진 (비전 없음).
 *
 * hdsign 어드민 네이티브 톤(틸/네이비, Banner+SubNav 크롬은 AdminLayout 이 제공).
 * 좌: 수동 항목 입력 폼 + 입력된 항목, 우: 견적엔진이 산출한 라인별 가격·근거·합계.
 * 코퍼스/priors 는 JWT 백엔드에서 lazy-fetch 후 캐시하며, 순수 견적엔진이 이를 근거로
 * 가격을 매긴다. 가격 계층: ① 이력 > ② 브랜드식별+사이즈 > ③ 카테고리+사이즈.
 * 비전·보정저장·easyform 은 후속 슬라이스에서 활성화(여기선 disabled placeholder).
 */

/** 폼 카테고리 선택지 — 라벨은 모두 견적엔진 resolveCategory 가 인식하는 값. */
const CATEGORIES = [
  '채널간판',
  '아크릴',
  '에폭시',
  '시트컷팅',
  'LED·네온·조명',
  '포맥스',
  '박스·조명박스',
  '도장',
  '시공·부착',
];

interface Entry {
  id: number;
  category: string;
  w: string;
  h: string;
  coats: string;
  qty: string;
  brandText: string;
}

interface PricedLine {
  entry: Entry;
  result: EstimateResult;
}

const won = (n: number): string => `₩${Math.round(n).toLocaleString('ko-KR')}`;

/** 입력 폼의 한 항목을 견적엔진 LineInput 으로 변환. */
function toLineInput(e: Entry): LineInput {
  const num = (s: string): number | undefined => {
    const v = Number(s);
    return Number.isFinite(v) && s.trim() !== '' ? v : undefined;
  };
  return {
    category: e.category,
    w: num(e.w),
    h: num(e.h),
    coats: num(e.coats),
    qty: num(e.qty) ?? 1,
    brandText: e.brandText.trim() || undefined,
  };
}

/** 근거 ref → 화면 칩 (클래스 + 짧은 라벨). 모든 비할인 라인은 ≥1 근거칩. */
function chipFor(ev: EvidenceRef): { cls: string; label: string } {
  if (ev.tier === '도장') return { cls: 'size', label: '도장' };
  switch (ev.type) {
    case 'history':
      return { cls: 'hist', label: `${ev.tier ?? '①'}이력` };
    case 'size':
      return { cls: 'size', label: `${ev.tier ?? ''} 사이즈곡선`.trim() };
    case 'correction':
      return { cls: 'corr', label: '보정 prior' };
    case 'category':
    default:
      return { cls: 'size', label: '카테고리' };
  }
}

function lineTitle(idx: number, e: Entry): string {
  const size = e.w && e.h ? ` ${e.w}×${e.h}` : '';
  const coats = e.coats && e.coats !== '0' ? ` · ${e.coats}도` : '';
  const qty = e.qty && e.qty !== '1' ? ` ×${e.qty}` : '';
  return `${idx + 1}. ${e.category}${size}${coats}${qty}`;
}

const emptyDraft = () => ({
  category: CATEGORIES[0],
  w: '',
  h: '',
  coats: '',
  qty: '1',
  brandText: '',
});

export default function AutoQuote() {
  const { token } = useAuth();
  const [corpus, setCorpus] = useState<CorpusItem[] | null>(null);
  const [priors, setPriors] = useState<Priors>({});
  const [dataError, setDataError] = useState<string | null>(null);

  const [draft, setDraft] = useState(emptyDraft());
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);
  const categoryRef = useRef<HTMLSelectElement>(null);

  // 탭 진입 시 corpus + priors 를 JWT 백엔드에서 lazy-fetch (모듈 캐시).
  useEffect(() => {
    let alive = true;
    loadAutoQuoteData(token)
      .then((d) => {
        if (!alive) return;
        setCorpus(d.corpus);
        setPriors(d.priors);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDataError(e instanceof Error ? e.message : '데이터 로드 실패');
        setCorpus([]); // 코퍼스 없이도 사이즈곡선 폴백으로 견적은 가능.
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // 입력된 항목마다 견적엔진을 돌려 가격·근거를 산출.
  const priced: PricedLine[] = useMemo(() => {
    if (corpus == null) return [];
    return entries.map((entry) => ({
      entry,
      result: estimate(toLineInput(entry), { corpus, priors }),
    }));
  }, [entries, corpus, priors]);

  const totals = useMemo(
    () => computeTotals(priced.map((p) => ({ amount: p.result.total }))),
    [priced],
  );

  const lowCount = priced.filter((p) => p.result.lowConfidence).length;
  const loading = corpus == null;

  const update = (patch: Partial<ReturnType<typeof emptyDraft>>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const addLine = () => {
    setEntries((prev) => [...prev, { id: nextId.current++, ...draft }]);
    setDraft((d) => ({ ...emptyDraft(), category: d.category }));
  };

  const removeLine = (id: number) =>
    setEntries((prev) => prev.filter((e) => e.id !== id));

  const focusForm = () => categoryRef.current?.focus();

  return (
    <div className="aq">
      <div className="aq-toolbar">
        <button type="button" className="aq-btn" onClick={focusForm}>
          ＋ 수동 항목 추가
        </button>
        <button type="button" className="aq-btn ghost" disabled title="다음 슬라이스에서 활성화">
          📋 이미지 붙여넣기
        </button>
        <button type="button" className="aq-btn ghost" disabled title="다음 슬라이스에서 활성화">
          🖥 easyform 자동기입
        </button>
        <span className="aq-spacer" />
        <button type="button" className="aq-btn ghost" disabled title="다음 슬라이스에서 활성화">
          🖼 내보내기
        </button>
        <span className="aq-seg">다음 슬라이스에서 활성화</span>
      </div>

      <div className="aq-grid">
        {/* LEFT — 수동 항목 입력 + 입력된 항목 */}
        <section className="aq-card">
          <h2>
            수동 항목 입력
            <span className="aq-seg">직접 입력 → 우측에서 자동 산출 (비전 없음)</span>
          </h2>
          <div className="aq-body">
            <div className="aq-form">
              <label className="span2">
                <span className="aq-lbl">품목 카테고리</span>
                <select
                  ref={categoryRef}
                  value={draft.category}
                  onChange={(e) => update({ category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="aq-lbl">가로 (mm)</span>
                <input
                  inputMode="numeric"
                  value={draft.w}
                  onChange={(e) => update({ w: e.target.value })}
                  placeholder="예: 3000"
                />
              </label>
              <label>
                <span className="aq-lbl">세로 (mm)</span>
                <input
                  inputMode="numeric"
                  value={draft.h}
                  onChange={(e) => update({ h: e.target.value })}
                  placeholder="예: 600"
                />
              </label>
              <label>
                <span className="aq-lbl">도수 (N도 · 도장 칠 횟수 1~7)</span>
                <input
                  type="number"
                  min="0"
                  max="7"
                  value={draft.coats}
                  onChange={(e) => update({ coats: e.target.value })}
                  placeholder="선택 (없으면 비움)"
                />
              </label>
              <label>
                <span className="aq-lbl">수량</span>
                <input
                  type="number"
                  min="1"
                  value={draft.qty}
                  onChange={(e) => update({ qty: e.target.value })}
                />
              </label>
              <label className="span2">
                <span className="aq-lbl">브랜드텍스트 (식별용, 선택)</span>
                <input
                  value={draft.brandText}
                  onChange={(e) => update({ brandText: e.target.value })}
                  placeholder="예: 투썸 · 식별필터로만 사용, 가격예측 아님"
                />
              </label>
            </div>
            <button type="button" className="aq-btn block" onClick={addLine}>
              추가
            </button>

            <div className="aq-entries-head">입력된 항목 ({entries.length})</div>
            {entries.length === 0 ? (
              <div className="aq-empty">
                항목을 직접 입력하면 우측에서 견적엔진이 가격과 근거를 산출합니다.
              </div>
            ) : (
              entries.map((e, i) => (
                <div className="aq-line" key={e.id}>
                  <div className="aq-line-top">
                    <span className="aq-name">{lineTitle(i, e)}</span>
                    <button
                      type="button"
                      className="aq-link warn"
                      onClick={() => removeLine(e.id)}
                    >
                      삭제
                    </button>
                  </div>
                  <div className="aq-why">
                    브랜드텍스트: {e.brandText.trim() ? `${e.brandText.trim()} (식별용)` : '—'}
                  </div>
                </div>
              ))
            )}

            <div className="aq-footnote">
              이 슬라이스는 비전(사진 인식)이 없습니다. 가격 계층: 이력 &gt; 브랜드식별+사이즈 &gt;
              카테고리+사이즈. “N도 = 도장 칠 횟수(1~7), 절곡 각도 아님.”
            </div>
          </div>
        </section>

        {/* RIGHT — 견적 내역 · 근거 + 합계 */}
        <section className="aq-card">
          <h2>
            견적 내역 · 근거
            {lowCount > 0 && (
              <span className="aq-flag" data-testid="review-flag">
                ⚠ {lowCount}건 검토요
              </span>
            )}
          </h2>
          <div className="aq-body">
            {dataError && <div className="aq-error">{dataError}</div>}
            {loading ? (
              <div className="aq-empty">학습 데이터를 불러오는 중…</div>
            ) : priced.length === 0 ? (
              <div className="aq-empty">
                왼쪽에서 항목을 추가하면 라인별 가격과 근거가 여기에 표시됩니다.
              </div>
            ) : (
              <>
                {priced.map(({ entry, result }, i) => {
                  const tone = result.lowConfidence ? ' low' : '';
                  return (
                    <div
                      className={`aq-line${tone}`}
                      data-testid="quote-line"
                      key={entry.id}
                    >
                      <div className="aq-line-top">
                        <span className="aq-name">
                          {lineTitle(i, entry)}
                          {result.lowConfidence && (
                            <span
                              className="aq-lowflag"
                              data-testid="low-confidence-flag"
                            >
                              낮은 신뢰도
                            </span>
                          )}
                        </span>
                        <span className="aq-price" data-testid="line-price">
                          {won(result.total)}
                        </span>
                      </div>

                      <div className="aq-chips">
                        {result.evidence.map((ev, j) => {
                          const c = chipFor(ev);
                          return (
                            <span
                              key={j}
                              className={`aq-chip ${c.cls}`}
                              data-testid="evidence-chip"
                            >
                              {c.label}
                            </span>
                          );
                        })}
                        {result.lowConfidence && (
                          <span className="aq-chip low" data-testid="evidence-chip">
                            낮은 신뢰도
                          </span>
                        )}
                      </div>

                      {result.coatWarning && (
                        <div className="aq-coatwarn" data-testid="coat-warning">
                          ⚠ {result.coatWarning}
                        </div>
                      )}

                      <details className="aq-corr" data-testid="why-expand">
                        <summary>왜 이 가격?</summary>
                        <ul className="aq-why-list">
                          {result.evidence.map((ev, j) => (
                            <li key={j}>{ev.note}</li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  );
                })}

                <div className="aq-total">
                  <span>소계</span>
                  <span>{won(totals.supply)}</span>
                </div>
                <div className="aq-total">
                  <span>부가세 (10%)</span>
                  <span>{won(totals.vat)}</span>
                </div>
                <div className="aq-total grand">
                  <span>합계</span>
                  <span data-testid="grand-total">{won(totals.total)}</span>
                </div>

                <div className="aq-footnote">
                  corpus·priors 는 JWT 백엔드에서 lazy-fetch — <code>GET /api/admin/autoquote/corpus</code>,{' '}
                  <code>GET /api/admin/autoquote/priors</code>. 보정 저장(공유 prior)과 비전은 다음
                  슬라이스에서 활성화됩니다.
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
