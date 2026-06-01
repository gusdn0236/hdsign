import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// AuthContext 는 .jsx — 확장자 명시로 vite/vitest 모두 해석되게.
import { useAuth } from '../../../context/AuthContext.jsx';
import { estimate, computeTotals, sizeBucket } from './engine';
import type {
  Correction,
  CorpusItem,
  EstimateResult,
  EvidenceRef,
  LineInput,
  Priors,
} from './engine';
import { loadAutoQuoteData } from './data/corpusClient';
import { loadCorrections, postCorrection } from './data/correctionsClient';
import { readImageFile, requestVision } from './components/visionClient';
import { visionToLineInputs } from './components/visionMapping';
import WorkOrderStage from './components/WorkOrderStage';
import type { OverlayPin } from './components/WorkOrderStage';
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

  // @slice-3 공유 보정(correction) — mount 시 lazy-fetch, 저장/다음견적 시 재요청.
  // 한 직원의 보정이 모든 직원의 다음 견적에서 TOP prior 로 되살아난다(엔진 findCorrection).
  const [corrections, setCorrections] = useState<Correction[]>([]);
  // 인라인 가격수정 폼 상태 — 한 번에 한 라인만 연다(entry.id).
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editReason, setEditReason] = useState('');
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  const [draft, setDraft] = useState(emptyDraft());
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);
  // 단일 비행(single-flight) 락 — visionState 는 비동기로 갱신되므로 ref 로 동기 차단.
  // 처리 중 두 번째 트리거(Ctrl+V 연타·버튼)가 동시 runVision 을 시작하지 못하게 한다.
  const visionBusy = useRef(false);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 비전(작업지시서) 상태. 'failed' → 폴백 배너 + 수동입력 유지(자동 재시도 없음).
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [visionState, setVisionState] =
    useState<'idle' | 'loading' | 'ok' | 'failed'>('idle');
  // 비전이 추가한 라인의 entry id — 이 라인들만 이미지 위 핀으로 오버레이.
  const [visionIds, setVisionIds] = useState<number[]>([]);

  // 공유 보정을 서버에서 재요청해 상태에 반영(저장 후·다음 견적 시 호출).
  // 실패해도 견적은 계속 동작하므로 조용히 무시(보정만 최신화 안 될 뿐).
  const refetchCorrections = useCallback(async () => {
    try {
      const fresh = await loadCorrections(token);
      setCorrections(fresh);
    } catch {
      /* 보정 로드 실패 — 기존 보정/견적 유지. */
    }
  }, [token]);

  // 탭 진입 시 corpus + priors + 공유 보정을 JWT 백엔드에서 lazy-fetch (corpus 는 모듈 캐시).
  // 보정은 다른 직원이 추가한 최신본까지 매 mount 가져온다 → 한 명의 보정이 모두에게 반영.
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
    loadCorrections(token)
      .then((c) => {
        if (alive) setCorrections(c);
      })
      .catch(() => {
        /* 보정 로드 실패 — 보정 없이도 견적은 동작. */
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // 저장 토스트 자동 해제(잠깐 보여주고 사라짐). 새 보정 폼을 열면 즉시 숨긴다.
  useEffect(() => {
    if (!savedToast) return;
    const t = setTimeout(() => setSavedToast(false), 4000);
    return () => clearTimeout(t);
  }, [savedToast]);

  // 입력된 항목마다 견적엔진을 돌려 가격·근거를 산출.
  const priced: PricedLine[] = useMemo(() => {
    if (corpus == null) return [];
    return entries.map((entry) => ({
      entry,
      result: estimate(toLineInput(entry), { corpus, priors, corrections }),
    }));
  }, [entries, corpus, priors, corrections]);

  const totals = useMemo(
    () => computeTotals(priced.map((p) => ({ amount: p.result.total }))),
    [priced],
  );

  const lowCount = priced.filter((p) => p.result.lowConfidence).length;
  const loading = corpus == null;

  // 비전이 검출한 라인의 가격 결과 → 이미지 위 오버레이 핀(낮은 신뢰도는 노랑).
  const visionPins: OverlayPin[] = useMemo(() => {
    const ids = new Set(visionIds);
    return priced
      .filter((p) => ids.has(p.entry.id))
      .map((p, i) => ({
        id: p.entry.id,
        tag: `${i + 1}. ${p.entry.category}${p.result.lowConfidence ? ' · 검토요' : ''}`,
        price: won(p.result.total),
        low: p.result.lowConfidence,
      }));
  }, [priced, visionIds]);

  /**
   * 이미지(업로드/붙여넣기) → 백엔드 비전 프록시 → 검출 라인 자동 추가.
   * 실패 시 폴백 배너만 띄우고 수동입력은 그대로 사용 가능(자동 재시도 없음).
   */
  const runVision = useCallback(
    async (file: Blob) => {
      // single-flight: 이미 처리 중이면 두 번째 호출은 즉시 무시(중복 /vision·중복 id 방지).
      if (visionBusy.current) return;
      visionBusy.current = true;
      setVisionState('loading');
      try {
        const { base64, mediaType } = await readImageFile(file);
        // 이미지는 먼저 표시 — 비전이 실패해도 작업지시서는 화면에 남는다.
        setImageSrc(`data:${mediaType};base64,${base64}`);
        const items = await requestVision(base64, mediaType, token);
        const lineInputs = visionToLineInputs(items);
        // id 를 한 번에 원자적으로 할당한다: 읽기(startId)와 쓰기(nextId.current 전진)
        // 사이에 await 가 없으므로 (락이 뚫리더라도) 두 번째 호출의 continuation 은 별도
        // 마이크로태스크로 이미 전진된 카운터를 읽어 같은 id 를 재사용하지 못한다 →
        // 중복 entry id / React key 충돌이 구조적으로 불가능. (이 ids 는 visionIds 에도
        // 동기적으로 필요하므로 setEntries 업데이터 안이 아니라 여기서 계산한다 — 업데이터는
        // async continuation 에서 호출 시 지연 실행되어 closure 로 값을 꺼낼 수 없다.)
        const startId = nextId.current;
        nextId.current = startId + lineInputs.length;
        const detected: Entry[] = lineInputs.map((li, i) => ({
          id: startId + i,
          category: li.category,
          w: li.w != null ? String(li.w) : '',
          h: li.h != null ? String(li.h) : '',
          coats: li.coats != null ? String(li.coats) : '',
          qty: String(li.qty ?? 1),
          brandText: li.brandText ?? '',
        }));
        setEntries((prev) => [...prev, ...detected]);
        setVisionIds(detected.map((e) => e.id));
        setVisionState('ok');
        // 다음 견적(새 작업지시서)마다 공유 보정을 재요청 — 다른 직원이 방금 올린
        // 보정까지 이 견적의 TOP prior 로 반영되게 한다.
        void refetchCorrections();
      } catch {
        // 비전 실패 — 폴백. 수동입력 경로는 계속 동작(엔진이 여전히 가격 산출).
        setVisionState('failed');
      } finally {
        visionBusy.current = false;
      }
    },
    [token, refetchCorrections],
  );

  // Ctrl+V 클립보드 이미지 붙여넣기 — 탭에 있는 동안 전역 paste 수신.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // 키보드(Ctrl+V) 경로에도 single-flight 가드 — 처리 중이면 새 붙여넣기를 무시한다.
      if (visionBusy.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            void runVision(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [runVision]);

  // '이미지 붙여넣기' 버튼 — Clipboard API 로 이미지를 직접 읽기(가능한 환경에서).
  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard?.read?.();
      for (const it of items ?? []) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          void runVision(blob);
          return;
        }
      }
    } catch {
      // 권한 거부/이미지 없음 — 사용자는 Ctrl+V 또는 파일 업로드로 진행 가능.
    }
  };

  const onUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void runVision(file);
    e.target.value = ''; // 같은 파일 재선택 허용.
  };

  const update = (patch: Partial<ReturnType<typeof emptyDraft>>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const addLine = () => {
    setEntries((prev) => [...prev, { id: nextId.current++, ...draft }]);
    setDraft((d) => ({ ...emptyDraft(), category: d.category }));
  };

  const removeLine = (id: number) =>
    setEntries((prev) => prev.filter((e) => e.id !== id));

  const focusForm = () => categoryRef.current?.focus();

  /** 인라인 가격수정 폼 열기/닫기 — 같은 라인을 다시 누르면 닫는다. */
  const toggleCorrectionForm = (entry: Entry) => {
    setCorrectionError(null);
    setSavedToast(false);
    if (editingId === entry.id) {
      setEditingId(null);
      return;
    }
    setEditingId(entry.id);
    setEditPrice('');
    setEditReason('');
  };

  /**
   * 공유 저장: 한 라인의 단가를 수정하고 이유를 적어 보정 API 로 POST 한다.
   *
   * featureKey 는 엔진과 동일한 SHARED 계약으로 만든다 —
   *   `${category}::${sizeBucket({ w, h })}`
   * (engine `findCorrection` 의 매칭측과 정확히 일치해야 보정이 올바른 사이즈에 적용된다).
   * author 는 절대 보내지 않는다(서버가 JWT principal 로 박는다).
   *
   * ANTI-FLAKY(job8 교훈): 저장이 성공하면 먼저 `correction-saved-toast` 를 띄운 뒤
   * 보정을 재요청·재견적한다 — save→reload 레이스 없이 토스트가 먼저 보이도록 보장.
   */
  const saveCorrection = async (entry: Entry) => {
    const price = Number(editPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setCorrectionError('수정 단가를 숫자로 입력하세요.');
      return;
    }
    if (!editReason.trim()) {
      setCorrectionError('수정 이유를 적어주세요(모든 직원에게 공유됩니다).');
      return;
    }
    const w = Number(entry.w);
    const h = Number(entry.h);
    const featureKey = `${entry.category}::${sizeBucket({
      w: Number.isFinite(w) ? w : undefined,
      h: Number.isFinite(h) ? h : undefined,
    })}`;
    setSavingCorrection(true);
    setCorrectionError(null);
    try {
      await postCorrection(token, {
        featureKey,
        correctedUnitPrice: price,
        explanation: editReason.trim(),
      });
      // 1) 토스트 먼저 — 재요청/재견적 전에 보이도록(레이스 방지).
      setSavedToast(true);
      setEditingId(null);
      // 2) 보정 재요청 → 재견적: 이 라인이 보정 단가를 TOP prior 로 표시.
      await refetchCorrections();
    } catch (e: unknown) {
      setCorrectionError(e instanceof Error ? e.message : '보정 저장 실패');
    } finally {
      setSavingCorrection(false);
    }
  };

  return (
    <div className="aq">
      {savedToast && (
        <div className="aq-toast" data-testid="correction-saved-toast" role="status">
          ✓ 수정 단가를 저장했습니다 — 모든 직원의 다음 견적에 공유됩니다.
        </div>
      )}
      <div className="aq-toolbar">
        <button
          type="button"
          className="aq-btn"
          onClick={pasteFromClipboard}
          disabled={visionState === 'loading'}
        >
          📋 이미지 붙여넣기 (Ctrl+V)
        </button>
        <button
          type="button"
          className="aq-btn ghost"
          data-testid="work-order-upload-btn"
          onClick={() => fileRef.current?.click()}
          disabled={visionState === 'loading'}
        >
          ⬆ 파일 업로드
        </button>
        <button type="button" className="aq-btn ghost" onClick={focusForm}>
          ＋ 수동 항목 추가
        </button>
        {/* Playwright/staffer 진입점 — 시각적으로 숨기되 기능은 유지. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="aq-file-input"
          data-testid="work-order-upload"
          onChange={onUploadChange}
        />
        <span className="aq-spacer" />
        <button type="button" className="aq-btn ghost" disabled title="다음 슬라이스에서 활성화">
          🖼 내보내기
        </button>
        <button type="button" className="aq-btn ghost" disabled title="다음 슬라이스에서 활성화">
          🖥 easyform 자동기입
        </button>
      </div>

      <div className="aq-grid">
        {/* LEFT — 수동 항목 입력 + 입력된 항목 */}
        <section className="aq-card">
          <h2>
            작업지시서 · 수동 입력
            <span className="aq-seg">붙여넣기/업로드 → 자동검출, 실패 시 수동 입력</span>
          </h2>
          <div className="aq-body">
            {visionState === 'ok' && (
              <div className="aq-vstatus" data-testid="vision-status">
                <span className="aq-dot" />
                비전 추출 완료 · {visionIds.length}개 항목 검출
                <span className="aq-vmono">(백엔드 프록시 · forced tool-use)</span>
              </div>
            )}
            {visionState === 'loading' && (
              <div className="aq-vstatus loading">
                <span className="aq-dot" />
                작업지시서 인식 중…
              </div>
            )}
            {visionState === 'failed' && (
              <div className="aq-vbanner" data-testid="vision-fallback-banner" role="alert">
                ⚠ 비전 실패 — 수동 입력으로 진행하세요. (자동 재시도 안 함)
              </div>
            )}

            {imageSrc && <WorkOrderStage imageSrc={imageSrc} pins={visionPins} />}

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
              작업지시서를 붙여넣기(Ctrl+V)/업로드하면 비전이 항목을 검출해 가격을 오버레이합니다.
              비전 실패 시 위 폼으로 수동 입력하세요. 가격 계층: 이력 &gt; 브랜드식별+사이즈 &gt;
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

                      {/* @slice-3 인라인 가격 수정 + 이유 적기 → 공유 보정 저장. */}
                      <div className="aq-correct">
                        <button
                          type="button"
                          className="aq-link"
                          onClick={() => toggleCorrectionForm(entry)}
                        >
                          ✎ 가격 수정 + 이유 적기
                        </button>
                        {editingId === entry.id && (
                          <div className="aq-correct-form">
                            <label className="aq-correct-row">
                              <span className="aq-lbl">수정 단가 (₩)</span>
                              <input
                                type="number"
                                min="0"
                                inputMode="numeric"
                                data-testid="correction-price"
                                value={editPrice}
                                onChange={(e) => setEditPrice(e.target.value)}
                                placeholder="예: 95000"
                              />
                            </label>
                            <label className="aq-correct-row">
                              <span className="aq-lbl">수정 이유 (공유됨)</span>
                              <textarea
                                data-testid="correction-reason"
                                value={editReason}
                                onChange={(e) => setEditReason(e.target.value)}
                                placeholder="예: 야간 시공 할증 포함"
                                rows={2}
                              />
                            </label>
                            {correctionError && (
                              <div className="aq-correct-err" role="alert">
                                {correctionError}
                              </div>
                            )}
                            <div className="aq-correct-actions">
                              <button
                                type="button"
                                className="aq-btn"
                                disabled={savingCorrection}
                                onClick={() => void saveCorrection(entry)}
                              >
                                {savingCorrection ? '저장 중…' : '공유 저장'}
                              </button>
                              <button
                                type="button"
                                className="aq-link"
                                onClick={() => toggleCorrectionForm(entry)}
                              >
                                취소
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
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
                  비전은 hdsign Java 백엔드 프록시(<code>POST /api/admin/autoquote/vision</code>)로 호출되며
                  ANTHROPIC 키는 서버 전용입니다(브라우저는 키를 보관/전송하지 않음). corpus·priors 도 JWT
                  백엔드에서 lazy-fetch. 가격을 수정하고 이유를 적어 “공유 저장”하면 모든 직원의
                  다음 견적에서 보정 단가가 TOP prior 로 적용됩니다.
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
