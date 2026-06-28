/**
 * LED 개수 계산 오버레이 — 명세서 작성 화면 지시서 위. (치수 오버레이와 별개 모드)
 *
 * 2단계 흐름(사장님 확정, 2026-06-22):
 *   1) 테두리 선택  — 'LED계산' 모드에서 "LED가 들어갈 테두리를 선택해주세요" 안내.
 *      · 클릭     = 그 테두리를 선택/해제(쉬프트 불필요, 치수 모드와 동일하게 클릭만으로 하나씩 추가).
 *      · 드래그   = 박스에 닿은 '가장 바깥 테두리(+그 안의 내경)' 만 추가. 내부 잡동사니/감싸는 컨테이너는 제외.
 *      선택을 끝내고 [확인] → 2단계.
 *   2) LED 채우기 — 지시서 사진을 숨기고(상위 onPlacing) 그 자리에 '선택한 벡터 테두리'만 띄운다.
 *      안쪽은 연한 색으로 칠하고(이응/미음 내경은 짝수-홀수 규칙으로 비움), LED 종류(3구/미들2구…)를 고르면
 *      그 모양 안에 조립규칙대로 LED 를 채워(=ledLayout.fillLeds) 개수를 보여준다.
 *
 * 좌표/정렬은 치수 오버레이와 동일한 dimMap(page_box 우선) 을 공용으로 쓴다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type DimGeom, type Mapped, type Projection, computeMapped, computeProjection, projectPoint, hitTestPolys } from './dimMap';
import { LED_SPECS, fillLeds, runMetrics, defaultCoeff, type FillResult, type LedSpec } from './ledLayout';
import { postLedSamples, loadLedCoeffs, type LedSample, type LedCoeff } from '../data/ledTrainingClient';

interface Props {
  geom: DimGeom | null;
  stageW: number;
  stageH: number;
  zoom: number;
  active: boolean;
  contentBox?: { x: number; y: number; w: number; h: number } | null;
  // 2단계(LED 채우기)로 들어가면 true — 상위(AutoQuote)가 지시서 사진을 숨기고 줌/팬을 리셋한다.
  onPlacing?: (placing: boolean) => void;
  statementRowCount?: number; // 현재 명세서 행 수 — '몇 번째 행'에 들어갈지 미리보기용.
  onApplyLed?: (items: { name: string; qty: number }[]) => void; // 적용하기 → 명세서에 행 추가.
  rowColor?: (i: number) => string; // 명세서 행 번호 동그라미 색(pinColor, 0-based index).
  token?: string | null; // 관리자 JWT — Ctrl+F8 실측 학습 POST/계수 GET 용.
  orderNumber?: string | null; // 실측 표본에 함께 저장(추적용, 선택).
}

const ROW_FALLBACK = ['#0a7d8c', '#4f8a5b', '#b07d3a', '#8a5a7d', '#c06a52', '#5a73a8', '#6b8e4e', '#4a8c8c'];

// 명세서 행 번호 동그라미(.rnum)와 같은 모양 — body 포털이라 CSS 미적용이라 인라인.
function RowBadge({ n, color }: { n: number; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        width: 19,
        height: 19,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        fontSize: 10.5,
        fontWeight: 800,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {n}
    </span>
  );
}

const SEL = '#2563eb'; // 선택 테두리(파랑) — 외경/내경 동일
const HOV = '#0a9396'; // 호버(청록)
const FILL_SOFT = 'rgba(37,99,235,0.13)'; // 2단계에서 모양 안쪽 연한 칠
// LED 실물 색(데모 HTML 기준) — 불은 데모(#ffd23f)보다 조금 더 밝게.
const BODY = '#2b3240'; // 모듈 본체(어두움)
const BULB = '#ffe45c'; // 구(LED 알) — 밝은 노랑
const BULB_EDGE = '#e0a800';
const BULB_GLOW = 'rgba(255,228,92,0.45)'; // 불빛 헤일로
const DETAIL = 1500; // 이하면 본체+구 풀 렌더 / 초과~MAX_DRAW 는 본체 사각만 / 더 많으면 개수만
const GLOW_MAX = 500; // 이하일 때만 불빛 헤일로(성능)
const MAX_DRAW = 6000; // 모듈 렌더 상한(넘으면 개수만)

// 학습 계수를 기본값 쪽으로 수축하는 prior 강도 — '기본값 = 표본 약 8개' 가치. (클수록 보수적)
const PRIOR_WEIGHT = 8;
// 서버 학습 계수(ov)를 그 종류의 기본계수 쪽으로 표본수 비례 수축해 스펙에 반영.
// 계수공간(A=1/areaPerLed, B=1/perimPerLed)에서 w=n/(n+K) 가중평균 → 소표본 편향 방지 + 매끄러운 수렴.
function blendSpec(base: LedSpec, ov: LedCoeff): LedSpec {
  const d = defaultCoeff(base);
  const w = ov.n / (ov.n + PRIOR_WEIGHT);
  const A0 = 1 / d.areaPerLed;
  const Al = ov.areaPerLed > 0 ? 1 / ov.areaPerLed : A0;
  const Ae = w * Al + (1 - w) * A0;
  const B0 = isFinite(d.perimPerLed) ? 1 / d.perimPerLed : 0;
  const Bl = ov.perimPerLed > 0 && ov.perimPerLed < 1e8 ? 1 / ov.perimPerLed : 0;
  const Be = w * Bl + (1 - w) * B0;
  return { ...base, areaPerLed: 1 / Ae, perimPerLed: Be > 1e-9 ? 1 / Be : Infinity };
}

type Phase = 'select' | 'place';

interface LetterRun {
  root: number; // 글자 외곽 객체 index
  members: number[]; // root + 구멍들
  polys: number[][][]; // 외곽+구멍 폴리곤(mm)
  center: { x: number; y: number }; // 글자 중심(mm) — 개수 라벨 위치
  key: string | null; // 이 글자의 LED 종류(없으면 미지정)
  fill: FillResult | null;
}

export default function LedOverlay({ geom, stageW, stageH, zoom, active, contentBox, onPlacing, statementRowCount, onApplyLed, rowColor, token, orderNumber }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const [ledKey, setLedKey] = useState<string | null>(null); // 전체 기본 LED 종류.
  const [typeMap, setTypeMap] = useState<Record<number, string>>({}); // 글자(root)별 LED 종류 덮어쓰기.
  const [placeSel, setPlaceSel] = useState<Set<number>>(new Set()); // 2단계에서 클릭/드래그로 고른 글자(root).
  const [phase, setPhase] = useState<Phase>('select');
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null); // 개발자 export 등 짧은 알림
  const drag = useRef<{ x0: number; y0: number; moved: boolean } | null>(null);
  const placingRef = useRef(onPlacing);
  placingRef.current = onPlacing;
  const exportRef = useRef<() => void>(() => {}); // Ctrl+F7 개발자 export — 항상 최신 클로저로 갱신.
  const inputRef = useRef<() => void>(() => {}); // Ctrl+F8 실측 개수 입력 — 항상 최신 클로저.

  // ── 자동학습(feedback loop) ──────────────────────────────────────────────
  // 서버가 쌓인 실측으로 피팅한 종류별 계수. ledLayout 기본값을 덮어쓴다(데이터 충분한 종류만).
  const [coeffs, setCoeffs] = useState<Record<string, LedCoeff>>({});
  // Ctrl+F8 실측 개수 입력 — 가운데 모달 대신 '글자별 예측 개수 박스'를 그 자리에서 키워 직접 입력.
  const [inputOpen, setInputOpen] = useState(false); // true=편집(입력) 모드.
  const [inputVals, setInputVals] = useState<Record<number, string>>({}); // root → 입력한 실제 개수(문자열).
  const [posting, setPosting] = useState(false);
  const [confirming, setConfirming] = useState(false); // '실측 저장' 클릭 후 한 번 더 확인 단계.
  const [prevErrPct, setPrevErrPct] = useState<number | null>(null); // 지난번 입력의 예측대비 오차%(추세 표시용).

  const proj = useMemo(() => computeProjection(geom, stageW, stageH, contentBox), [geom, stageW, stageH, contentBox]);
  const mapped = useMemo(() => computeMapped(geom, stageW, stageH, contentBox), [geom, stageW, stageH, contentBox]);

  // 2단계 전용 투영 — 선택 벡터의 mm 외곽선 bbox 를 '빈 캔버스'(stageW×stageH) 정중앙에 fit.
  // 원래 지시서 위치와 무관하게, 선택 모양만 새 페이지 가운데로 옮겨 키워 보여준다.
  const placeProj = useMemo<Projection | null>(() => {
    if (phase !== 'place' || !geom || sel.size === 0 || !stageW || !stageH) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of sel) {
      const pts = geom.objects[i]?.points;
      if (!pts) continue;
      for (const [mx, my] of pts) {
        if (mx < minX) minX = mx;
        if (mx > maxX) maxX = mx;
        if (my < minY) minY = my;
        if (my > maxY) maxY = my;
      }
    }
    if (!isFinite(minX)) return null;
    const bw = Math.max(1e-6, maxX - minX);
    const bh = Math.max(1e-6, maxY - minY);
    const margin = 0.12; // 가장자리 여백(양쪽 12%)
    const scale = Math.min((stageW * (1 - margin * 2)) / bw, (stageH * (1 - margin * 2)) / bh);
    const cw = bw * scale;
    const ch = bh * scale;
    return { ox: (stageW - cw) / 2, oy: (stageH - ch) / 2, cw, ch, ext: { x: minX, y: minY, w: bw, h: bh } };
  }, [phase, geom, sel, stageW, stageH]);

  // 선택을 '객체(잔넬)' 단위로 묶어 각각 따로 채운다 — 객체마다 시작(고무캡)·끝이 따로.
  // 묶기: 선택끼리 bbox 포함관계 깊이가 짝수면 외곽(=한 객체), 홀수면 그 안의 구멍. 구멍은 자신을
  // 감싸는 가장 작은 외곽 객체에 붙인다. (FILA 4글자 → 4개 객체 → 4쌍의 시작/끝)
  const runs = useMemo<LetterRun[]>(() => {
    if (!geom || sel.size === 0) return [];
    const idx = [...sel].filter((i) => {
      const p = geom.objects[i]?.points;
      return Array.isArray(p) && p.length >= 2;
    });
    if (!idx.length) return [];
    const ob = (i: number) => geom.objects[i];
    const enc = (i: number, j: number) => {
      const a = ob(i);
      const b = ob(j);
      return !!a && !!b && a.x <= b.x + 0.01 && a.y <= b.y + 0.01 && a.x + a.w >= b.x + b.w - 0.01 && a.y + a.h >= b.y + b.h - 0.01 && a.w * a.h > b.w * b.h;
    };
    const depth = (i: number) => idx.filter((j) => j !== i && enc(j, i)).length;
    const parent = (h: number) => {
      let best: number | null = null;
      let bestArea = Infinity;
      for (const j of idx) {
        if (j !== h && enc(j, h)) {
          const ar = ob(j).w * ob(j).h;
          if (ar < bestArea) {
            bestArea = ar;
            best = j;
          }
        }
      }
      return best;
    };
    // 전체 선택의 중심(mm) — 각 글자의 '끝'을 이쪽으로 모아 배선을 묶기 쉽게.
    let mnx = Infinity;
    let mny = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    for (const i of idx) {
      const o = ob(i);
      if (o.x < mnx) mnx = o.x;
      if (o.y < mny) mny = o.y;
      if (o.x + o.w > mxx) mxx = o.x + o.w;
      if (o.y + o.h > mxy) mxy = o.y + o.h;
    }
    const centerHint = { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 };
    const roots = idx.filter((i) => depth(i) % 2 === 0);
    return roots.map((root) => {
      const holes = idx.filter((h) => depth(h) % 2 === 1 && parent(h) === root);
      const memberIdx = [root, ...holes];
      const polys = memberIdx.map((i) => ob(i).points as number[][]);
      const o = ob(root);
      const center = { x: o.x + o.w / 2, y: o.y + o.h / 2 }; // 글자 중심(mm) — 개수 라벨 위치.
      const key = typeMap[root] ?? null; // 글자별 종류(전역 기본 없음 — 토글로 채우고 비운다)
      const base = key ? LED_SPECS.find((s) => s.key === key) : undefined;
      // 학습 계수가 있으면 기본값 쪽으로 '표본수 비례 수축(shrinkage)' 블렌드해서 적용.
      //   덮어쓰기(순수 최소제곱)는 초기 소표본이 편향되면 기본값보다 나빠질 수 있음(검증됨).
      //   계수공간(A=1/areaPerLed, B=1/perimPerLed)에서 w=n/(n+K) 가중평균 → 소표본=기본값 우세,
      //   데이터 쌓일수록 학습값 우세. 절대 기본값보다 못해지지 않고 매끄럽게 수렴한다.
      const ov = key ? coeffs[key] : undefined;
      const spec = base && ov ? blendSpec(base, ov) : base;
      const fill = spec ? fillLeds(polys, spec, centerHint) : null;
      return { root, members: memberIdx, polys, center, key, fill };
    });
  }, [geom, typeMap, sel, coeffs]);

  const totalCount = runs.reduce((s, r) => s + (r.fill?.count ?? 0), 0);
  const totalChains = runs.reduce((s, r) => s + (r.fill?.chains.length ?? 0), 0); // 시작/끝 쌍 수
  // 2단계에서 글자(벡터)를 선택하면 그 선택의 총 높이(mm)를 벡터 옆에 표시 — 그 mm bbox.
  let placeSelBox: { mnx: number; mny: number; mxx: number; mxy: number } | null = null;
  if (geom && placeSel.size > 0) {
    let mnx = Infinity;
    let mny = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    for (const root of placeSel) {
      const o = geom.objects[root];
      if (!o) continue;
      if (o.x < mnx) mnx = o.x;
      if (o.y < mny) mny = o.y;
      if (o.x + o.w > mxx) mxx = o.x + o.w;
      if (o.y + o.h > mxy) mxy = o.y + o.h;
    }
    if (isFinite(mnx)) placeSelBox = { mnx, mny, mxx, mxy };
  }
  const placeSelHeight = placeSelBox ? Math.round(placeSelBox.mxy - placeSelBox.mny) : 0;
  // 모듈(3구 등) 상세 렌더 임계값은 '모듈 개수'로만 판단 — 연속형(줄/PCB)은 개수가 커서 섞이면
  // 임계값을 넘겨 다른 글자 상세렌더가 꺼지는 문제가 있어 분리한다.
  const moduleCount = runs.reduce((s, r) => (r.fill && r.fill.spec.family === 'module' ? s + r.fill.count : s), 0);

  // 종류별 총합 + '몇 번째 행'에 들어갈지(현재 명세서 행 수 다음부터 순서대로). 명세서 반영 미리보기/적용용.
  const baseRow = statementRowCount ?? 0;
  const applyItems = LED_SPECS.map((s) => ({ spec: s, qty: runs.reduce((a, r) => (r.fill && r.key === s.key ? a + r.fill.count : a), 0) }))
    .filter((t) => t.qty > 0)
    .map((t, i) => ({ name: t.spec.name, label: t.spec.name, color: t.spec.color, qty: t.qty, row: baseRow + i + 1 }));

  // ── 개발자 전용 export (Ctrl+F7) ────────────────────────────────────────
  // 선택한 벡터(실제 외곽선 mm) + 현재 알고리즘이 깐 개수를 JSON 으로 내려받는다.
  // 이 파일을 클로드코드에 주고 "실제로는 N개 넣었다" 라고 알려주면, 그 N에 맞춰 알고리즘(ledLayout.fillLeds)
  // 가중치/간격을 튜닝한다. led_lab.py(=동일 알고리즘 파이썬 포팅) 가 바로 읽어 재현·시각화할 수 있는 포맷.
  const exportSelection = () => {
    if (!geom || sel.size === 0) {
      setToast('내보낼 선택 벡터가 없습니다');
      setTimeout(() => setToast(null), 1800);
      return;
    }
    // led_geom_*.json 호환 — objects[].{x,y,w,h,type,points}. index 보존(런 멤버 추적용).
    const objects = [...sel].map((i) => {
      const o = geom.objects[i];
      return { index: i, x: o.x, y: o.y, w: o.w, h: o.h, type: o.type ?? null, points: o.points ?? [] };
    });
    // 런(글자) 그룹 — 프론트가 묶은 외곽+구멍 + 그 글자에 지정된 LED 종류 + 현재 알고리즘 개수.
    const runOut = runs.map((r) => ({
      root: r.root,
      members: r.members,
      ledKey: r.key,
      algoCount: r.fill?.count ?? 0,
      chains: r.fill?.chains.length ?? 0,
      center: r.center,
      polys: r.polys,
    }));
    const payload = {
      note: 'HD LED dev export (Ctrl+F7). 선택 벡터 + 현재 알고리즘 결과. led_lab.py 로 재현해 실제 개수와 비교/튜닝.',
      unit_mm: geom.unit_mm ?? 1.0,
      ledSpecs: LED_SPECS, // 알고리즘이 쓰는 모듈 스펙(본체 w×h, 선길이 등) 그대로.
      selection: { count: sel.size, objects },
      runs: runOut,
      totals: {
        algoCount: totalCount, // 알고리즘이 깐 총 개수(이걸 실제 개수와 맞추는 게 목표).
        chains: totalChains,
        byType: applyItems.map((it) => ({ name: it.name, qty: it.qty })),
      },
      // ↓ 사람이 채워 넣는 칸 — 실제로 넣은 개수(종류별). 클로드코드가 이 값에 알고리즘을 맞춘다.
      actual: { byType: applyItems.map((it) => ({ name: it.name, qty: it.qty, ACTUAL: null })), note: '' },
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `led_sel_${sel.size}obj_${runs.length}run.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      /* 다운로드 실패해도 콘솔엔 남긴다 */
    }
    // 클립보드 폴백 + 콘솔(파일 못 받는 환경 대비).
    try {
      navigator.clipboard?.writeText(json);
    } catch {
      /* noop */
    }
    // eslint-disable-next-line no-console
    console.log('[LED export]', payload);
    setToast(`벡터 ${sel.size}개(글자 ${runs.length}) 내보냄 ✓ — 알고리즘 ${totalCount}개`);
    setTimeout(() => setToast(null), 2600);
  };
  exportRef.current = exportSelection;

  // ── Ctrl+F8 실측 개수 입력(자동학습) ───────────────────────────────────────
  // 사장님이 글자별 '실제로 넣은 LED 개수'를 입력 → 서버에 누적 → 서버가 계수 재피팅 → 즉시 반영.
  const openInput = () => {
    // 예측 개수가 나온(=LED 종류가 지정된) 글자가 있어야 그 박스에 실측을 적을 수 있다.
    const editable = runs.filter((r) => r.fill && r.fill.count > 0);
    if (!geom || editable.length === 0) {
      setToast('LED 종류를 먼저 골라 예측 개수가 나온 글자가 있어야 합니다');
      setTimeout(() => setToast(null), 2200);
      return;
    }
    if (inputOpen) {
      setInputOpen(false); // F8 다시 누르면 편집 종료(토글).
      return;
    }
    const vals: Record<number, string> = {};
    for (const r of editable) vals[r.root] = '';
    setInputVals(vals);
    try {
      const v = localStorage.getItem('hd_led_last_err_pct'); // 지난번 입력 오차%(추세 비교용).
      setPrevErrPct(v != null ? parseFloat(v) : null);
    } catch {
      setPrevErrPct(null);
    }
    setInputOpen(true);
  };
  inputRef.current = openInput;

  // 입력된 실측 vs 현재 예측값(LED계산 표시값)의 종합 오차. 모달 표시·저장 토스트 공용.
  //   sumDiff = Σ|실제-예측|(LED 개수 차이), pct = sumDiff/sumPred×100(예측 대비 몇 %가 수정될지).
  const errorSummary = () => {
    let sumPred = 0;
    let sumAct = 0;
    let sumDiff = 0;
    let cmpN = 0;
    for (const r of runs) {
      const v = inputVals[r.root];
      const a = v != null && v.trim() !== '' ? parseInt(v, 10) : NaN;
      if (!r.fill || !Number.isFinite(a) || a <= 0) continue;
      sumPred += r.fill.count;
      sumAct += a;
      sumDiff += Math.abs(a - r.fill.count);
      cmpN++;
    }
    const pct = sumPred > 0 ? (sumDiff / sumPred) * 100 : 0;
    return { sumPred, sumAct, sumDiff, pct, cmpN };
  };

  // 입력 완료 → 표본 POST → 계수 재로드(즉시 반영). 클로드/AI 안 씀(서버 순수 산술).
  const submitSamples = async () => {
    const sum = errorSummary(); // 저장 전에 '예측 대비 오차'를 계산해 토스트/추세에 쓴다.
    const samples: LedSample[] = [];
    for (const r of runs) {
      const raw = inputVals[r.root];
      const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : NaN;
      const ledType = r.key; // 글자에 지정된 LED 종류(예측 박스가 그 종류로 계산됨).
      if (!ledType || !Number.isFinite(n) || n <= 0) continue;
      const { area, perim } = runMetrics(r.polys);
      if (!(area > 0)) continue;
      samples.push({ ledType, area, perim, actualCount: n, orderNumber: orderNumber ?? null, polysJson: JSON.stringify(r.polys) });
    }
    if (samples.length === 0) {
      setToast('입력된 개수가 없습니다');
      setTimeout(() => setToast(null), 1800);
      return;
    }
    setPosting(true);
    try {
      const saved = await postLedSamples(token, samples);
      const fresh = await loadLedCoeffs(token); // 방금 저장분 반영해 바로 갱신.
      setCoeffs(fresh);
      // 이번 입력의 '예측 대비 오차'를 기록 — 다음 입력 때 '지난번 X% → 이번 Y%' 추세로 보여준다.
      try {
        localStorage.setItem('hd_led_last_err_pct', sum.pct.toFixed(2));
      } catch {
        /* noop */
      }
      setPrevErrPct(sum.pct);
      setInputOpen(false);
      setToast(`실측 ${saved}건 저장 ✓ — 예측과 ${sum.sumDiff}개 차이, 총 ${sum.pct.toFixed(2)}% 오차 수정됨`);
      setTimeout(() => setToast(null), 3400);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '저장 실패');
      setTimeout(() => setToast(null), 2800);
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  };

  // 모드 활성 시 서버의 학습 계수 1회 로드(실패해도 조용히 기본값 유지).
  useEffect(() => {
    if (!active) return;
    let alive = true;
    loadLedCoeffs(token).then((c) => {
      if (alive) setCoeffs(c);
    });
    return () => {
      alive = false;
    };
  }, [active, token]);

  // Ctrl+F7 — 개발자 export, Ctrl+F8 — 실측 개수 입력(모드 활성 동안). 브라우저 기본동작 막음.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F7' && e.ctrlKey) {
        e.preventDefault();
        exportRef.current?.();
      } else if (e.key === 'F8' && e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // 모드가 꺼지면 1단계로 초기화 + 사진 복원.
  useEffect(() => {
    if (!active) {
      setPhase('select');
      setLedKey(null);
      setTypeMap({});
      setPlaceSel(new Set());
      placingRef.current?.(false);
    }
  }, [active]);

  // place(2단계 채움)를 벗어나면 실측 입력 편집 모드도 자동 종료 — 모달 닫기·모드 종료 등 모든 경로 커버.
  useEffect(() => {
    if (phase !== 'place') setInputOpen(false);
  }, [phase]);

  // 편집 모드를 닫으면 확인 단계도 리셋.
  useEffect(() => {
    if (!inputOpen) setConfirming(false);
  }, [inputOpen]);

  // 새 주문(geom 교체) — 선택/단계 전부 리셋.
  useEffect(() => {
    setSel(new Set());
    setPhase('select');
    setLedKey(null);
    setTypeMap({});
    setPlaceSel(new Set());
    placingRef.current?.(false);
  }, [geom]);

  const toSelect = () => {
    setPhase('select');
    setPlaceSel(new Set());
    setInputOpen(false); // 종류 모달 닫으면(빨간 X) 실측 입력 편집 모드도 함께 종료.
    onPlacing?.(false);
  };
  const toPlace = () => {
    if (sel.size === 0) return;
    // 2단계 = 빈 캔버스 정중앙에 선택 벡터를 새로 배치(placeProj). 상위는 줌/팬을 리셋한다.
    setPhase('place');
    onPlacing?.(true);
  };
  // 현재 '대상' 글자(root) — 글자를 골랐으면 그 글자들, 아니면 전체. 종류 토글의 기준.
  const ctxRoots = placeSel.size > 0 ? [...placeSel] : runs.map((r) => r.root);
  // 대상 글자들에 현재 들어간 종류들 — 버튼 색칠(둘 다 쓰면 둘 다 색칠)용.
  const activeKeys = [...new Set(ctxRoots.map((root) => typeMap[root]).filter((k): k is string => !!k))];

  // 종류 버튼 토글:
  //  - 글자 선택 중: 그 종류면 그 글자들에서 제거, 아니면 그 종류로 채움.
  //  - 선택 없음(전체): 색칠된(쓰는) 종류 누르면 그 LED 전부 제거 / 전부 비었을 때만 누르면 전체 채움.
  const toggleType = (key: string) => {
    if (placeSel.size > 0) {
      const roots = [...placeSel];
      const allHave = roots.every((r) => typeMap[r] === key);
      setTypeMap((prev) => {
        const n = { ...prev };
        for (const r of roots) allHave ? delete n[r] : (n[r] = key);
        return n;
      });
      return;
    }
    const allRoots = runs.map((r) => r.root);
    if (activeKeys.includes(key)) {
      setTypeMap((prev) => {
        const n = { ...prev };
        for (const r of allRoots) if (n[r] === key) delete n[r];
        return n;
      });
    } else if (allRoots.every((r) => !typeMap[r])) {
      // 전부 비었을 때만 전체 채움.
      setTypeMap((prev) => {
        const n = { ...prev };
        for (const r of allRoots) n[r] = key;
        return n;
      });
    }
  };
  // 종류 초기화 — 글자별 지정 모두 해제(처음부터).
  const resetTypes = () => {
    setLedKey(null);
    setTypeMap({});
    setPlaceSel(new Set());
  };

  if (!active || !geom || !proj || mapped.length === 0) {
    // 모드가 꺼져도 toolbar 까지 사라지면 깜빡임 → active 일 때만 전체 렌더.
    // 툴바는 body 로 포털 — stage 의 transform(확대/축소) 영향을 안 받게(fixed 가 제대로 동작).
    return active
      ? createPortal(
          <LedToolbar
            phase={phase}
            activeKeys={activeKeys}
            onPickType={toggleType}
            selCount={sel.size}
            placeSelCount={placeSel.size}
            count={totalCount}
            runCount={runs.length}
            pairCount={totalChains}
            note={runs.find((r) => r.fill?.note)?.fill?.note}
            capped={false}
            onConfirm={toPlace}
            onBack={toSelect}
            onClear={() => setSel(new Set())}
            onReset={resetTypes}
            applyItems={applyItems}
            onApply={() => onApplyLed?.(applyItems.map((it) => ({ name: it.name, qty: it.qty })))}
            rowColor={rowColor}
            toast={toast}
          />,
          document.body,
        )
      : null;
  }

  const toContent = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 가운데버튼=팬은 상위로 전파(둘 다)
    e.stopPropagation();
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    drag.current = { x0: p.x, y0: p.y, moved: false };
    setHover(null);
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onMove = (e: React.MouseEvent) => {
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    if (drag.current) {
      const dx = Math.abs(p.x - drag.current.x0);
      const dy = Math.abs(p.y - drag.current.y0);
      if (dx > 3 || dy > 3) drag.current.moved = true;
      setMarquee({ x0: drag.current.x0, y0: drag.current.y0, x1: p.x, y1: p.y });
    } else if (phase === 'select') {
      setHover(hitTestPolys(mapped, geom.objects, proj, p.x, p.y, zoom));
    }
  };

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    setMarquee(null);
    if (!d) return;
    e.stopPropagation();
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;

    // ── 2단계: 글자(잔넬) 선택 — 종류를 따로 줄 글자 고르기. 선택은 새 선택(빈곳=해제) ──
    if (phase === 'place') {
      if (!d.moved) {
        const root = hitLetterPlace(p.x, p.y);
        setPlaceSel(root == null ? new Set() : new Set([root])); // 빈곳=해제 / 다른 글자=새 선택
        return;
      }
      const qx0 = Math.min(d.x0, p.x);
      const qy0 = Math.min(d.y0, p.y);
      const qx1 = Math.max(d.x0, p.x);
      const qy1 = Math.max(d.y0, p.y);
      const hits = runs.map((r) => ({ r, c: pj(r.center.x, r.center.y) })).filter(({ c }) => c.x >= qx0 && c.x <= qx1 && c.y >= qy0 && c.y <= qy1).map(({ r }) => r.root);
      setPlaceSel(new Set(hits)); // 드래그 = 그 박스 글자들로 새 선택
      return;
    }

    if (!d.moved) {
      // 클릭 — 그 테두리 하나 토글(클릭만으로 추가, 다시 클릭하면 해제).
      const hit = hitTestPolys(mapped, geom.objects, proj, p.x, p.y, zoom);
      if (hit == null) return;
      setSel((prev) => {
        const next = new Set(prev);
        next.has(hit) ? next.delete(hit) : next.add(hit);
        return next;
      });
      return;
    }

    // 드래그(마퀴) — 박스에 닿은 '가장 바깥 테두리(+내경)' 만 누적 추가.
    const rx0 = Math.min(d.x0, p.x);
    const ry0 = Math.min(d.y0, p.y);
    const rx1 = Math.max(d.x0, p.x);
    const ry1 = Math.max(d.y0, p.y);
    const cand = mapped.filter((m) => {
      const overlaps = m.sx < rx1 && m.sx + m.sw > rx0 && m.sy < ry1 && m.sy + m.sh > ry0;
      if (!overlaps) return false;
      // 마퀴 전체를 감싸는 큰 컨테이너(페이지 박스 등)는 제외.
      const wrapsMarquee = m.sx < rx0 && m.sy < ry0 && m.sx + m.sw > rx1 && m.sy + m.sh > ry1;
      return !wrapsMarquee;
    });
    // 다른 후보 '안에' 들어있는 깊이: 0=바깥 테두리, 1=내경(구멍). 2단계 이상(구멍 속 잡동사니)은 버린다.
    const inside = (A: Mapped, B: Mapped) =>
      A !== B &&
      A.sx <= B.sx + 0.5 &&
      A.sy <= B.sy + 0.5 &&
      A.sx + A.sw >= B.sx + B.sw - 0.5 &&
      A.sy + A.sh >= B.sy + B.sh - 0.5 &&
      A.sw * A.sh > B.sw * B.sh;
    const keep = cand.filter((m) => cand.filter((o) => inside(o, m)).length <= 1).map((m) => m.i);
    setSel((prev) => new Set([...prev, ...keep]));
  };

  const placing = phase === 'place';
  // 활성 투영 — 1단계는 지시서 정렬(proj), 2단계는 빈 캔버스 중앙 배치(placeProj).
  const P = placing && placeProj ? placeProj : proj;

  const lw = 1.5 / zoom;
  const ptsOf = (i: number) => geom.objects[i]?.points;
  const polyPath = (pts?: number[][]): string => {
    if (!pts || pts.length < 2) return '';
    let dstr = '';
    for (let k = 0; k < pts.length; k++) {
      const s = projectPoint(P, pts[k][0], pts[k][1]);
      dstr += (k ? 'L' : 'M') + s.x.toFixed(1) + ',' + s.y.toFixed(1) + ' ';
    }
    return dstr + 'Z';
  };
  // 선택 전체를 한 path 로 합쳐 짝수-홀수 칠(내경=구멍 자동 비움). 테두리 선은 외경/내경 구분 없이 파랑.
  const selArr = [...sel];
  const selPath = selArr.map((i) => polyPath(ptsOf(i))).join(' ');

  // 모듈 화면 크기(mm→px). x/y 스케일 분리(보통 같지만 안전하게).
  const sxScale = P.cw / P.ext.w;
  const syScale = P.ch / P.ext.h;

  const drawFull = placing && moduleCount > 0 && moduleCount <= DETAIL; // 본체+구+배선
  const drawSimple = placing && moduleCount > DETAIL && moduleCount <= MAX_DRAW; // 본체만
  const capped = moduleCount > MAX_DRAW;
  const glow = drawFull && moduleCount <= GLOW_MAX;

  const pj = (mx: number, my: number) => projectPoint(P, mx, my);
  const f1 = (n: number) => n.toFixed(1);

  // 2단계에서 화면 점(콘텐츠 px)이 어느 글자(run) 안인지 — 투영된 폴리곤 짝수-홀수 판정.
  const hitLetterPlace = (x: number, y: number): number | null => {
    for (const r of runs) {
      let inside = false;
      for (const poly of r.polys) {
        const n = poly.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const pi = pj(poly[i][0], poly[i][1]);
          const pjj = pj(poly[j][0], poly[j][1]);
          if (pi.y > y !== pjj.y > y) {
            const xint = pi.x + ((y - pi.y) / (pjj.y - pi.y)) * (pjj.x - pi.x);
            if (x < xint) inside = !inside;
          }
        }
      }
      if (inside) return r.root;
    }
    return null;
  };

  // 객체(run) 하나의 LED 렌더 — body=잔넬 안(클립O: 선·본체·구·시작캡), ends=잔넬 밖(클립X: 끝 두갈래).
  const renderRun = (lr: LetterRun, ri: number): { body: React.ReactNode; ends: React.ReactNode } => {
    const run = lr.fill;
    if (!run) return { body: null, ends: null };
    const spec = run.spec;
    if (spec.family === 'linear') {
      return {
        body: (
          <g key={'run' + ri} pointerEvents="none">
            {run.rows.flatMap((row, r) =>
              row.segs.map(([a, b], s) => {
                const p0 = pj(a, row.cy);
                const p1 = pj(b, row.cy);
                return <line key={`l${ri}-${r}-${s}`} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={spec.color} strokeWidth={Math.max(2 / zoom, (spec.stripH || 1) * syScale * 4)} opacity={0.9} strokeLinecap="round" />;
              }),
            )}
            {run.count <= 2000 &&
              run.rows.flatMap((row, r) =>
                row.segs.flatMap(([a, b], s) => {
                  const unit = spec.unitMm || 2.5;
                  const n = Math.round((b - a) / unit);
                  const dots: React.ReactNode[] = [];
                  for (let i = 0; i < n; i++) {
                    const c = pj(a + unit * (i + 0.5), row.cy);
                    dots.push(<circle key={`d${ri}-${r}-${s}-${i}`} cx={c.x} cy={c.y} r={Math.max(0.6, 0.6 * sxScale)} fill="#cbd5e1" />);
                  }
                  return dots;
                }),
              )}
          </g>
        ),
        ends: null,
      };
    }
    if (!(drawFull || drawSimple)) return { body: null, ends: null };
    const chains = run.chains;
    if (!chains.length) return { body: null, ends: null };
    const longMm = spec.w ?? 0;
    const thickMm = spec.h ?? 0;
    const bulbN = spec.bulbs ?? 0;
    const bulbR = Math.max(0.6, Math.min(thickMm * 0.32, bulbN ? (longMm / (bulbN + 1)) * 0.4 : thickMm * 0.3) * sxScale);
    const edgeW = Math.max(0.3, thickMm * 0.04 * sxScale); // 본체 테두리선 굵기
    const bodyLen = longMm * sxScale; // 본체 긴 변
    const bodyThick = thickMm * sxScale; // 본체 두께
    const bodyRx = Math.min(bodyLen, bodyThick) * 0.28;
    // 모듈 k 의 화면 회전각 — 직진 구간은 가로(0)/세로(90)로 스냅해 균일하게, 실제 꺾이는
    // 모듈에서만 들어오고-나가는 방향의 평균각으로 자연스럽게 회전시킨다.
    const dirScreen = (a: { cx: number; cy: number }, b: { cx: number; cy: number }) => {
      const p0 = pj(a.cx, a.cy);
      const p1 = pj(b.cx, b.cy);
      return { x: p1.x - p0.x, y: p1.y - p0.y };
    };
    const snap = (d: { x: number; y: number }) => (Math.abs(d.x) >= Math.abs(d.y) ? 0 : 90);
    const angleAt = (ch: { cx: number; cy: number }[], k: number): number => {
      const cur = ch[k];
      const prev = ch[k - 1];
      const next = ch[k + 1];
      let inD = prev ? dirScreen(prev, cur) : null;
      let outD = next ? dirScreen(cur, next) : null;
      if (!inD && !outD) return 0;
      inD = inD ?? outD!;
      outD = outD ?? inD;
      if (snap(inD) === snap(outD)) return snap(inD);
      const ai = Math.atan2(inD.y, inD.x);
      const ao = Math.atan2(outD.y, outD.x);
      return (Math.atan2(Math.sin(ai) + Math.sin(ao), Math.cos(ai) + Math.cos(ao)) * 180) / Math.PI;
    };
    // 사잇선·시작캡·혓바닥 전부 제거 — 모듈(본체+구)만 면적에 고르게. 회전각은 알고리즘이 준 국소 획 방향.
    const bodyEls: React.ReactNode[] = [];
    chains.forEach((ch, ci) => {
      const mods = ch.map((p, k) => {
        const c = pj(p.cx, p.cy);
        let deg: number;
        if (p.deg !== undefined) {
          // 알고리즘이 준 국소 획 방향(mm) → 화면 각으로 투영(Y 뒤집힘·스케일 보정).
          const r = (p.deg * Math.PI) / 180;
          const d = pj(p.cx + Math.cos(r), p.cy + Math.sin(r));
          deg = (Math.atan2(d.y - c.y, d.x - c.x) * 180) / Math.PI;
        } else {
          deg = angleAt(ch, k); // 폴백 — 이웃 방향을 가로(0)/세로(90)로 스냅.
        }
        return { c, deg };
      });
      bodyEls.push(
        <g key={`c${ci}`}>
          {mods.map((m, k) => (
            <g key={`m${k}`} transform={`translate(${f1(m.c.x)},${f1(m.c.y)}) rotate(${m.deg.toFixed(1)})`}>
              <rect x={-bodyLen / 2} y={-bodyThick / 2} width={bodyLen} height={bodyThick} rx={bodyRx} fill={BODY} stroke="#1b2230" strokeWidth={edgeW} />
              {drawFull &&
                Array.from({ length: bulbN }, (_, i) => {
                  const bx = ((i + 1) / (bulbN + 1) - 0.5) * bodyLen;
                  return (
                    <g key={i}>
                      {glow && <circle cx={bx} cy={0} r={bulbR * 1.9} fill={BULB_GLOW} />}
                      <circle cx={bx} cy={0} r={bulbR} fill={BULB} stroke={BULB_EDGE} strokeWidth={Math.max(0.3, bulbR * 0.16)} />
                    </g>
                  );
                })}
            </g>
          ))}
        </g>,
      );
    });
    return { body: <g key={'run' + ri} pointerEvents="none">{bodyEls}</g>, ends: null };
  };

  return (
    <>
      <svg
        ref={svgRef}
        className="aq-dimsvg"
        style={{ position: 'absolute', left: 0, top: 0, width: stageW, height: stageH, overflow: 'visible', cursor: placing ? 'default' : 'crosshair' }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => {
          setHover(null);
          if (drag.current) {
            drag.current = null;
            setMarquee(null);
          }
        }}
      >
        {/* 2단계: 지시서 자리를 흰 바탕으로 덮어 '선택한 테두리만' 깔끔히 보이게. */}
        {placing && <rect x={0} y={0} width={stageW} height={stageH} fill="#ffffff" />}
        {!placing && <rect x={0} y={0} width={stageW} height={stageH} fill="transparent" />}

        {/* 1단계 호버 — 실제 테두리 옅게 */}
        {!placing && hover != null && !sel.has(hover) && (
          <path d={polyPath(ptsOf(hover))} fill="rgba(10,147,150,0.08)" stroke={HOV} strokeWidth={lw} pointerEvents="none" />
        )}

        {/* 선택한 모양 안쪽 연한 칠(짝수-홀수=내경 비움) — 2단계에서 강조 */}
        {selPath && (
          <path d={selPath} fillRule="evenodd" fill={placing ? FILL_SOFT : 'rgba(37,99,235,0.07)'} stroke="none" pointerEvents="none" />
        )}
        {/* 선택된 벡터 테두리 강조 — 외경/내경 구분 없이 파란 실선(구멍은 짝수-홀수 칠로 표현) */}
        {selArr.map((i) => (
          <path key={i} d={polyPath(ptsOf(i))} fill="none" stroke={SEL} strokeWidth={lw * 1.3} pointerEvents="none" />
        ))}

        {/* 채운 LED — 객체(잔넬)마다 따로. body는 잔넬 모양으로 clip(선·모듈이 테두리 밖 안 나감),
            ends(끝 두 갈래)는 clip 밖으로 그려 잔넬 경계를 넘어 보이게. */}
        {placing &&
          selPath &&
          (() => {
            const rendered = runs.map((run, ri) => renderRun(run, ri));
            return (
              <>
                <defs>
                  <clipPath id="aq-led-clip" clipPathUnits="userSpaceOnUse">
                    <path d={selPath} clipRule="evenodd" />
                  </clipPath>
                </defs>
                <g clipPath="url(#aq-led-clip)">{rendered.map((r) => r.body)}</g>
                {rendered.map((r) => r.ends)}
              </>
            );
          })()}

        {/* 2단계: 글자 선택 하이라이트(주황) — 종류를 따로 줄 글자 */}
        {placing &&
          runs.map((r, i) =>
            placeSel.has(r.root) ? (
              <g key={`hl${i}`} pointerEvents="none">
                {r.polys.map((poly, pi) => (
                  <path key={pi} d={polyPath(poly)} fill="none" stroke="#f59e0b" strokeWidth={lw * 2.4} />
                ))}
              </g>
            ) : null,
          )}

        {/* 2단계: 선택한 벡터(글자)들의 총 높이 라벨 — 벡터 옆(위쪽) */}
        {placing &&
          placeSelBox &&
          (() => {
            const c = pj((placeSelBox.mnx + placeSelBox.mxx) / 2, placeSelBox.mxy); // mm Y=위쪽 → maxY=상단
            const wpx = 70 / zoom;
            const hpx = 19 / zoom;
            return (
              <g pointerEvents="none">
                <rect x={c.x - wpx / 2} y={c.y - hpx - 6 / zoom} width={wpx} height={hpx} rx={4 / zoom} fill="rgba(245,158,11,0.95)" />
                <text x={c.x} y={c.y - 9.5 / zoom} textAnchor="middle" fontSize={12.5 / zoom} fontWeight={800} fill="#3b2300">
                  H:{placeSelHeight}mm
                </text>
              </g>
            );
          })()}

        {/* 2단계: 글자별 LED 개수 — 평소엔 예측 라벨, Ctrl+F8 편집 모드엔 그 자리에서 키운 입력 박스.
            예측 박스(스펙 색 테두리·남색) vs 실제 입력 박스(초록)로 색 구분. */}
        {placing &&
          runs.map((r, i) => {
            if (!r.fill || !r.fill.count) return null;
            const c = pj(r.center.x, r.center.y);
            const predicted = r.fill.count;
            // 편집 모드 — 키운 입력 박스(foreignObject 로 HTML input 삽입, 줌에 맞춰 /zoom).
            if (inputOpen) {
              const val = inputVals[r.root] ?? '';
              const edited = val.trim() !== '' && parseInt(val, 10) > 0;
              const w = 56 / zoom;
              const h = 30 / zoom;
              return (
                <foreignObject key={`ed${i}`} x={c.x - w / 2} y={c.y - h / 2} width={w} height={h} style={{ overflow: 'visible' }}>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={val}
                    placeholder={String(predicted)}
                    onChange={(e) => setInputVals({ ...inputVals, [r.root]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        if (!posting) setInputOpen(false);
                      } else if (e.key === 'Enter') {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    title={`예측 ${predicted}개 — 실제로 넣은 개수를 적으세요`}
                    style={{
                      width: '100%',
                      height: '100%',
                      boxSizing: 'border-box',
                      textAlign: 'center',
                      fontSize: `${15 / zoom}px`,
                      fontWeight: 800,
                      borderRadius: `${6 / zoom}px`,
                      border: `${2.4 / zoom}px solid ${edited ? '#22c55e' : r.fill.spec.color}`,
                      background: edited ? '#0f2a1a' : '#111a2e',
                      color: edited ? '#bbf7d0' : '#e5e7eb',
                      outline: 'none',
                      padding: 0,
                      boxShadow: edited ? `0 0 ${6 / zoom}px rgba(34,197,94,0.6)` : 'none',
                    }}
                  />
                </foreignObject>
              );
            }
            // 평소 — 예측 개수 라벨(읽기 전용).
            const txt = String(predicted);
            const wpx = (txt.length * 8 + 14) / zoom;
            const hpx = 18 / zoom;
            return (
              <g key={`lbl${i}`} pointerEvents="none">
                <rect x={c.x - wpx / 2} y={c.y - hpx / 2} width={wpx} height={hpx} rx={4 / zoom} fill="rgba(17,26,46,0.88)" stroke={r.fill.spec.color} strokeWidth={1 / zoom} />
                <text x={c.x} y={c.y + 4.5 / zoom} textAnchor="middle" fontSize={12 / zoom} fontWeight={700} fill="#fff">
                  {txt}
                </text>
              </g>
            );
          })}

        {/* 마퀴 */}
        {marquee && (
          <rect
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            fill="rgba(37,99,235,0.08)"
            stroke={SEL}
            strokeWidth={lw}
            strokeDasharray={`${5 / zoom} ${4 / zoom}`}
            pointerEvents="none"
          />
        )}
      </svg>

      {createPortal(
        <LedToolbar
          phase={phase}
          activeKeys={activeKeys}
          onPickType={toggleType}
          selCount={sel.size}
          placeSelCount={placeSel.size}
          count={totalCount}
          runCount={runs.length}
          pairCount={totalChains}
          note={runs.find((r) => r.fill?.note)?.fill?.note}
          capped={capped}
          onConfirm={toPlace}
          onBack={toSelect}
          onClear={() => setSel(new Set())}
          onReset={resetTypes}
          applyItems={applyItems}
          onApply={() => onApplyLed?.(applyItems.map((it) => ({ name: it.name, qty: it.qty })))}
          rowColor={rowColor}
          toast={toast}
        />,
        document.body,
      )}

      {/* Ctrl+F8 실측 개수 입력 — 가운데 모달 대신 글자별 예측 박스를 직접 편집(아래 SVG). 상단엔 요약+저장 바만. */}
      {inputOpen &&
        createPortal(
          (() => {
            const sum = errorSummary();
            return (
              <div
                style={{
                  position: 'fixed',
                  left: '50%',
                  top: 16,
                  transform: 'translateX(-50%)',
                  zIndex: 9002,
                  background: '#111a2e',
                  color: '#f8fafc',
                  border: '1px solid #334155',
                  borderRadius: 12,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                  padding: '9px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  maxWidth: '94vw',
                  flexWrap: 'wrap',
                  fontSize: 13,
                }}
              >
                <strong style={{ fontSize: 14 }}>✏️ 실제 LED 개수 입력</strong>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>
                  각 글자의 <b style={{ color: '#22c55e' }}>초록 박스</b>에 실제로 넣은 개수를 적으세요
                </span>
                {sum.cmpN > 0 && (
                  <>
                    <span style={{ width: 1, height: 20, background: '#334155' }} />
                    <span style={{ fontSize: 12.5 }}>
                      예측 {sum.sumPred} → 실제 {sum.sumAct} · 예측갯수와 <b style={{ color: '#fca5a5' }}>{sum.sumDiff}개</b> 차이로, 총{' '}
                      <b style={{ color: '#fca5a5', fontSize: 14 }}>{sum.pct.toFixed(2)}%</b>의 오차가 수정될 예정입니다.
                      {prevErrPct != null && (
                        <span style={{ color: '#64748b', marginLeft: 6 }}>
                          (지난번 {prevErrPct.toFixed(2)}% → 이번 {sum.pct.toFixed(2)}%{' '}
                          {sum.pct < prevErrPct ? (
                            <b style={{ color: '#86efac' }}>▼ 줄어듦</b>
                          ) : sum.pct > prevErrPct ? (
                            <b style={{ color: '#fcd34d' }}>▲ 늘어남</b>
                          ) : (
                            '='
                          )}
                          )
                        </span>
                      )}
                    </span>
                  </>
                )}
                <span style={{ width: 1, height: 20, background: '#334155' }} />
                {confirming ? (
                  // 한 번 더 확인 — 학습(코드 동작)에 반영되므로.
                  <>
                    <span style={{ fontSize: 12.5, color: '#fde68a', fontWeight: 700 }}>
                      입력한 개수로 오차를 수정(학습에 반영)하시겠습니까?
                    </span>
                    <button
                      onClick={() => setConfirming(false)}
                      disabled={posting}
                      style={{ cursor: 'pointer', padding: '6px 12px', borderRadius: 8, fontSize: 12.5, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontWeight: 700 }}
                    >
                      아니오
                    </button>
                    <button
                      onClick={submitSamples}
                      disabled={posting}
                      style={{ cursor: posting ? 'default' : 'pointer', padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 800, border: 'none', background: posting ? '#1e3a5f' : '#22c55e', color: '#06270f' }}
                    >
                      {posting ? '저장 중…' : '예, 수정합니다'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => !posting && setInputOpen(false)}
                      style={{ cursor: 'pointer', padding: '6px 12px', borderRadius: 8, fontSize: 12.5, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontWeight: 700 }}
                    >
                      취소
                    </button>
                    <button
                      onClick={() => {
                        if (sum.cmpN === 0) {
                          setToast('입력된 개수가 없습니다');
                          setTimeout(() => setToast(null), 1800);
                          return;
                        }
                        setConfirming(true);
                      }}
                      style={{ cursor: 'pointer', padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 800, border: 'none', background: '#22c55e', color: '#06270f' }}
                    >
                      실측 저장
                    </button>
                  </>
                )}
              </div>
            );
          })(),
          document.body,
        )}

    </>
  );
}

function LedToolbar({
  phase,
  activeKeys,
  onPickType,
  selCount,
  placeSelCount,
  count,
  runCount,
  pairCount,
  note,
  capped,
  onConfirm,
  onBack,
  onClear,
  onReset,
  applyItems,
  onApply,
  rowColor,
  toast,
}: {
  phase: Phase;
  activeKeys: string[];
  onPickType: (k: string) => void;
  selCount: number;
  placeSelCount: number;
  count: number;
  runCount: number;
  pairCount: number;
  note?: string;
  capped?: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onClear: () => void;
  onReset: () => void;
  applyItems: { name: string; label: string; color: string; qty: number; row: number }[];
  onApply: () => void;
  rowColor?: (i: number) => string;
  toast?: string | null;
}) {
  const rowCol = (i: number) => (rowColor ? rowColor(i) : ROW_FALLBACK[i % ROW_FALLBACK.length]);
  // 개발자 export(Ctrl+F7) 등 짧은 알림 배지 — 툴바 위에 떠서 1~2초 뒤 사라진다.
  const toastBadge = toast ? (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 78,
        transform: 'translateX(-50%)',
        zIndex: 9001,
        background: '#0f2a1a',
        color: '#bbf7d0',
        border: '1px solid #22c55e',
        borderRadius: 8,
        padding: '7px 14px',
        fontSize: 12.5,
        fontWeight: 700,
        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        whiteSpace: 'nowrap',
      }}
    >
      {toast}
    </div>
  ) : null;
  const wrap: React.CSSProperties = {
    position: 'fixed',
    left: '50%',
    bottom: 18,
    transform: 'translateX(-50%)',
    zIndex: 9000,
    background: '#111a2e',
    color: '#f8fafc',
    border: '1px solid #334155',
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    maxWidth: '94vw',
    flexWrap: 'wrap',
    fontSize: 13,
  };

  // ── 1단계: 테두리 선택 ────────────────────────────────
  if (phase === 'select') {
    return (
      <>
      {toastBadge}
      <div style={wrap}>
        <span style={{ fontWeight: 700 }}>💡 LED</span>
        {selCount === 0 ? (
          <span style={{ color: '#cbd5e1' }}>LED가 들어갈 <b style={{ color: '#7dd3fc' }}>테두리를 선택</b>해주세요</span>
        ) : (
          <span>
            총 <b style={{ color: '#7dd3fc', fontSize: 15 }}>{selCount}</b>개 선택됨
          </span>
        )}
        <span style={{ width: 1, height: 22, background: '#334155' }} />
        <span style={{ color: '#94a3b8', fontSize: 11.5 }}>클릭=하나씩 추가 · 드래그=바깥 테두리 · 안쪽 객체 클릭=내경(구멍) 토글 · 다시 클릭=해제</span>
        {selCount > 0 && (
          <>
            <button
              type="button"
              onClick={onClear}
              style={{ cursor: 'pointer', padding: '5px 10px', borderRadius: 8, fontSize: 12, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1' }}
            >
              선택해제
            </button>
            <button
              type="button"
              onClick={onConfirm}
              style={{ cursor: 'pointer', padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 800, border: '1.5px solid #22c55e', background: '#22c55e', color: '#06270f' }}
            >
              확인 →
            </button>
          </>
        )}
      </div>
      </>
    );
  }

  // ── 2단계: LED 종류 선택 → 채움 개수 ──────────────────
  return (
    <>
    {toastBadge}
    <div style={wrap}>
      {/* 모달(검정 툴바) 우측 상단 끝의 빨간 X — 닫으면 1단계(지시서)로 돌아가 테두리 다시 선택. */}
      <button
        type="button"
        onClick={onBack}
        title="닫기 — 테두리 다시 선택(지시서로)"
        style={{
          position: 'absolute',
          top: -12,
          right: -12,
          zIndex: 1,
          width: 30,
          height: 30,
          borderRadius: '50%',
          border: '2px solid #fff',
          background: '#ef4444',
          color: '#fff',
          fontSize: 16,
          fontWeight: 800,
          lineHeight: '26px',
          cursor: 'pointer',
          boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
        }}
      >
        ✕
      </button>
      <span style={{ fontWeight: 700 }}>💡 종류</span>
      {placeSelCount > 0 ? (
        <span style={{ color: '#fbbf24', fontSize: 12 }}>글자 {placeSelCount}개 선택됨 — 종류 누르면 이 글자만 적용</span>
      ) : (
        <span style={{ color: '#94a3b8', fontSize: 11.5 }}>(글자 클릭/드래그=그 글자만 다르게)</span>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {LED_SPECS.map((s) => {
          const on = activeKeys.includes(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onPickType(s.key)}
              title={s.family === 'module' ? `${s.name} · 본체 ${s.w}×${s.h}mm · 선길이 ${s.wire}mm` : `${s.name} · ${s.unitMm}mm마다 1개`}
              style={{
                cursor: 'pointer',
                padding: '5px 10px',
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 700,
                border: `1.5px solid ${on ? s.color : '#475569'}`,
                background: on ? s.color : 'transparent',
                color: on ? '#fff' : '#cbd5e1',
              }}
            >
              {s.name}
            </button>
          );
        })}
      </div>

      <span style={{ width: 1, height: 22, background: '#334155' }} />
      {count === 0 ? (
        <span style={{ color: '#94a3b8' }}>선택 {selCount}개 · LED 종류를 고르세요</span>
      ) : (
        <button
          type="button"
          onClick={onReset}
          title="LED 종류 지정 초기화 — 전체/글자별 모두 해제"
          style={{ cursor: 'pointer', padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 800, border: '1.5px solid #f59e0b', background: '#f59e0b', color: '#3b2300' }}
        >
          초기화
        </button>
      )}

      {/* 명세서 반영 미리보기 + 적용하기 — 종류별 총합을 '몇 번째 행'에 넣을지 보여주고 누르면 행 추가. */}
      {applyItems.length > 0 && (
        <>
          <span style={{ width: 1, height: 22, background: '#334155' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#0b1322', border: '1px solid #334155', borderRadius: 8, padding: '6px 10px' }}>
            {applyItems.map((it) => (
              <span key={it.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <RowBadge n={it.row} color={rowCol(it.row - 1)} />
                <span style={{ color: '#94a3b8' }}>번째 행</span>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: it.color, display: 'inline-block' }} />
                <b>{it.label}</b>
                <b style={{ color: '#7dd3fc' }}>{it.qty.toLocaleString()}개</b>
              </span>
            ))}
            <button
              type="button"
              onClick={onApply}
              style={{ cursor: 'pointer', padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 800, border: '1.5px solid #22c55e', background: '#22c55e', color: '#06270f' }}
            >
              명세서에 적용하기
            </button>
            {/* 개발자 단축키 안내 — 적용하기 옆 아주 작은 회색 글씨 */}
            <span style={{ fontSize: 10.5, color: '#64748b', whiteSpace: 'nowrap' }}>Ctrl+F7 = 벡터 JSON 내보내기 · Ctrl+F8 = 실제 개수 입력</span>
          </div>
        </>
      )}
    </div>
    </>
  );
}
