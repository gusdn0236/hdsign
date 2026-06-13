/**
 * 자동견적 주석입력 — 순수 헬퍼 + 계산기 로직.
 *
 * 바탕화면 프로토타입(build_annot_prototype.py)의 검증된 vanilla JS 로직을 그대로 포팅.
 * DOM/네트워크 없음 — 단위 테스트 가능. 계산기 단가표는 hdsign /admin/prices 와 동일한
 * frontend/src/data/calc/prices.json(acryl/gomu)을 사용한다.
 *
 * 도메인 메모: 글자높이 밴드 × 한글/영문 → 글자당 단가, 수량 = 글자수.
 */
// 계산기 단가표(acryl/gomu) — admin/prices 와 동일 소스. 키에 한글('한글'/'영문')이 섞여 있어 any 로 다룬다.
import pricesJson from '../../../../data/calc/prices.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_CALC: any = (pricesJson as any).calculators || {};
// 계산기 전체 노출(acryl/gomu/epoxy/channel/goldSilver/led/frame) — 자동 단가가 여러 자재를 본다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CALC: any = ALL_CALC;

export const FIELDS = ['품목코드', '품목', '규격', '수량', '단가'] as const;
export type Field = (typeof FIELDS)[number];

// ---- 숫자/문자 정규화 (프로토타입 동일) --------------------------------

export function num(s: unknown): number | null {
  const m = String(s == null ? '' : s).replace(/[^0-9]/g, '');
  return m ? parseInt(m, 10) : null;
}

export function cnorm(s: string): string {
  return (s || '').toLowerCase().replace(/\(주\)|주식회사/g, '').replace(/[^0-9a-z가-힣]/g, '');
}

/** 사이즈 → 면적값. AxB=면적, h:NNN=높이², 단일숫자=². 오버플로 방지로 number(=double) 사용. */
export function sizev(s: string): number | null {
  const t = (s || '').toLowerCase();
  let m = t.match(/(\d{2,5})\s*[*x×]\s*(\d{2,5})/);
  if (m) return +m[1] * +m[2];
  m = t.match(/h\s*[:：]?\s*(\d{2,4})/);
  if (m) return +m[1] * +m[1];
  m = t.match(/(\d{2,5})/);
  return m ? +m[1] * +m[1] : null;
}

// ---- 단가 찾아보기 — 같은 품목유형 판정 (프로토타입 동일) ------------------

export function typeKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z가-힣]/g, '');
}

/** 유형 유사: 부분일치(갈바레이져 ⊂ 갈바레이져타공) 또는 앞 3글자 접두 일치(갈바레이져≈갈바레이저). */
export function ksim(a: string, qk: string): boolean {
  if (!a || !qk) return false;
  if (a.indexOf(qk) >= 0 || qk.indexOf(a) >= 0) return true;
  return a.length >= 3 && qk.length >= 3 && a.slice(0, 3) === qk.slice(0, 3);
}

/** 사이즈 근접도 0~1 (작은쪽/큰쪽). qs 없으면 0. */
export function szClose(lineSize: number | null, qs: number | null): number {
  if (!qs) return 0;
  if (!lineSize) return 0;
  return Math.min(qs, lineSize) / Math.max(qs, lineSize);
}

// ---- 계산기 밴드 (프로토타입 동일) ----------------------------------------

export function acrylBand(mm: number): string {
  if (mm <= 30) return '~30';
  const r = Math.ceil((mm - 30) / 10);
  const low = 31 + (r - 1) * 10;
  return low + '~' + (low + 9);
}

export function gomuBand(mm: number): string | null {
  if (mm <= 149) return '~149';
  if (mm <= 999) {
    const r = Math.floor((mm - 150) / 50) + 1;
    const low = 150 + (r - 1) * 50;
    return low + '~' + (low + 49);
  }
  if (mm > 2000) return null;
  const r = 18 + Math.floor((mm - 1000) / 100);
  const low = 1000 + (r - 18) * 100;
  return low + '~' + (low + 99);
}

export interface ParsedCode {
  calc: 'acryl' | 'gomu' | 'epoxy' | 'channel' | 'goldsilver' | 'led' | 'frame';
  tk: string | null;
}

/**
 * 품목코드 → 계산기 종류 + 두께(예: 아크릴3T → {calc:'acryl', tk:'3T'}).
 * 판정 순서가 중요: '금경아크릴3T'는 금은경(아크릴 아님), '갈바후광'은 잔넬, '갈바에폭시'는 에폭시.
 * 에폭시는 '에폭시' 단어가 있어야만(맨 갈바/스텐은 잔넬·기타와 모호하므로 미판정).
 */
export function parseCode(code: string): ParsedCode | null {
  const s = (code || '').toLowerCase().replace(/\s/g, '');
  let calc: ParsedCode['calc'] | null = null;
  if (/금경|은경|금은/.test(s)) calc = 'goldsilver';
  else if (/고무|스카시/.test(s)) calc = 'gomu';
  else if (/에폭시/.test(s)) calc = 'epoxy';
  else if (/잔넬|채널|후광|오사이|타카|일체형|골드스텐|알미늄캡|channel/.test(s)) calc = 'channel';
  else if (/아크릴|포맥스/.test(s)) calc = 'acryl';
  else if (/led|엘이디/.test(s)) calc = 'led';
  else if (/후렘|프레임|frame/.test(s)) calc = 'frame';
  let tk: string | null = null;
  const m = s.match(/(\d+(?:,\d+)?)\s*t/);
  if (m) tk = m[1].toUpperCase() + 'T';
  return calc ? { calc, tk } : null;
}

export function sizeFromSpec(spec: string): number | null {
  const m = (spec || '').match(/\d{2,4}/);
  return m ? parseInt(m[0], 10) : null;
}

export function charCount(text: string, mode: 'ko' | 'en' | 'all'): number {
  const t = (text || '').replace(/\s+/g, '');
  if (mode === 'ko') return (t.match(/[가-힣]/g) || []).length;
  if (mode === 'en') return (t.match(/[A-Za-z0-9]/g) || []).length;
  return t.length;
}

export interface CalcResult {
  ok: true;
  unit: number;
  qty: number;
  desc: string;
  /** 피스 단위 자재(잔넬 등) — 수량을 글자수로 덮어쓰지 말 것(사용자가 개수 입력). */
  perPiece?: boolean;
}
export interface CalcError {
  ok: false;
  message: string;
}

/** 아크릴/포맥스 계산. tt='한글'|'영문', cmode=글자수 카운트 모드. */
export function computeAcryl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calc: any,
  tk: string,
  tt: '한글' | '영문',
  item: string,
  spec: string,
  cmode: 'ko' | 'en' | 'all',
): CalcResult | CalcError {
  if (!calc?.acryl) return { ok: false, message: '아크릴 단가표가 없어요.' };
  if (!tk || !calc.acryl.prices[tk]) {
    return { ok: false, message: '두께를 품목코드에 적어주세요 (예: 아크릴3T). 등록: 2T·3T·5T·8T·10T·15T·20T' };
  }
  const mm = sizeFromSpec(spec);
  if (!mm) return { ok: false, message: '규격에 글자 높이(mm)를 먼저 입력하세요. 예: H100, 150' };
  const band = acrylBand(mm);
  const unit = ((calc.acryl.prices[tk] || {})[tt] || {})[band];
  if (unit == null) {
    return {
      ok: false,
      message: `아크릴 ${tk} ${tt} ${mm}mm(밴드 ${band}) 단가가 표에 없어요.${mm > 890 ? ' (890mm까지만 등록)' : ''}`,
    };
  }
  const qty = charCount(item, cmode);
  if (!qty) return { ok: false, message: '글자수가 0이에요.' };
  return { ok: true, unit, qty, desc: `아크릴 ${tk} · ${tt} · ${mm}mm(밴드 ${band})` };
}

/** 고무스카시 계산. */
export function computeGomu(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calc: any,
  tk: string | null,
  item: string,
  spec: string,
): CalcResult | CalcError {
  if (!calc?.gomu || !tk || !calc.gomu.prices[tk]) {
    return { ok: false, message: `고무스카시 ${tk || '?'} 단가표가 없어요. 품목코드에 두께(10T/50T 등)를 적어주세요.` };
  }
  const mm = sizeFromSpec(spec);
  if (!mm) return { ok: false, message: '규격에 글자 높이(mm)를 입력하세요.' };
  const band = gomuBand(mm);
  const unit = band ? calc.gomu.prices[tk][band] : null;
  if (unit == null) {
    return { ok: false, message: `고무스카시 ${tk} ${mm}mm(밴드 ${band}) 단가가 표에 없어요.` };
  }
  const qty = charCount(item, 'all');
  if (!qty) return { ok: false, message: '글자수가 0이에요.' };
  return { ok: true, unit, qty, desc: `고무스카시 ${tk} · ${mm}mm(밴드 ${band})` };
}

// ---- 잔넬·에폭시(추가 계산기) ----------------------------------------------

/** 잔넬 사이즈 축(smallStep+largeStep) → 등록 사이즈 목록. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function channelSizeList(sizeAxis: any): number[] {
  if (!sizeAxis) return [];
  const out: number[] = [];
  const { smallStep, largeStep } = sizeAxis;
  for (let s = smallStep.from; s <= smallStep.to; s += smallStep.step) out.push(s);
  for (let s = largeStep.from; s <= largeStep.to; s += largeStep.step) out.push(s);
  return out;
}

/** 입력 높이(mm)를 등록 사이즈 중 가장 가까운 값으로 스냅. */
export function snapSize(sizes: number[], mm: number | null): number | null {
  if (!sizes.length || mm == null) return null;
  let best = sizes[0];
  let bd = Math.abs(sizes[0] - mm);
  for (const s of sizes) {
    const d = Math.abs(s - mm);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** 에폭시 재질 — 코드에 '스텐' 있으면 stainless, 아니면 galvalume(갈바). */
export function epoxyMat(code: string): 'galvalume' | 'stainless' {
  return /스텐|stainless/i.test(code || '') ? 'stainless' : 'galvalume';
}

/** 에폭시 — 현재 (재질·한/영·높이)에서 고를 수 있는 획두께 값 목록(드롭다운용). 비면 미지원. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function epoxyStrokeOptions(calc: any, code: string, item: string, spec: string): number[] {
  const ep = calc?.epoxy;
  if (!ep) return [];
  const mat = epoxyMat(code);
  const tt = /[가-힣]/.test(item) ? 'korean' : 'englishNumber';
  const mm = sizeFromSpec(spec);
  const sizes = Object.keys(ep.prices?.[mat]?.[tt] || {}).map(Number);
  const size = snapSize(sizes, mm);
  if (size == null) return [];
  return Object.keys(ep.prices?.[mat]?.[tt]?.[String(size)] || {})
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * 에폭시 계산 — 글자단위(한글=korean / 영문=englishNumber). 획두께(stroke)는 호출부 드롭다운 선택값.
 * 재질=코드(갈바/스텐), 높이=규격(등록 사이즈로 스냅), 글자수=품목. cmode 로 한/영만 세기(혼합 합산용).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeEpoxy(
  calc: any,
  code: string,
  item: string,
  spec: string,
  stroke: number,
  cmode?: 'ko' | 'en' | 'all',
): CalcResult | CalcError {
  const ep = calc?.epoxy;
  if (!ep) return { ok: false, message: '에폭시 단가표가 없어요.' };
  const mat = epoxyMat(code);
  const tt = (cmode ? cmode === 'ko' : /[가-힣]/.test(item)) ? 'korean' : 'englishNumber';
  const mm = sizeFromSpec(spec);
  if (!mm) return { ok: false, message: '규격에 글자 높이(mm)를 입력하세요.' };
  const sizes = Object.keys(ep.prices?.[mat]?.[tt] || {}).map(Number);
  const size = snapSize(sizes, mm);
  if (size == null) return { ok: false, message: '에폭시 단가표에 사이즈가 없어요.' };
  const unit = ep.prices?.[mat]?.[tt]?.[String(size)]?.[String(stroke)];
  if (unit == null) {
    return { ok: false, message: `에폭시 ${mat === 'stainless' ? '스텐' : '갈바'} ${size}mm 획두께 ${stroke} 단가가 없어요.` };
  }
  const qty = charCount(item, cmode || (/[가-힣]/.test(item) ? 'ko' : 'en'));
  if (!qty) return { ok: false, message: '글자수가 0이에요.' };
  return {
    ok: true,
    unit,
    qty,
    desc: `에폭시 ${mat === 'stainless' ? '스텐' : '갈바'} ${size}mm · ${tt === 'korean' ? '한글' : '영문'} · 획${stroke}`,
  };
}

/** 코드 → 잔넬 종류 key. 모호(맨 '잔넬' 등)하면 null → 자동 안 함. 후광은 한/영 키로 분기. */
const CH_TYPE_RULES: Array<[RegExp, string]> = [
  [/골드스텐/, 'goldSten'],
  [/타카/, 'takaType'],
  [/일체형/, 'ilcheType'],
  [/알미늄/, 'stenAlumCap'],
  [/스텐.*오사이|오사이.*스텐/, 'stenOsai'],
  [/스텐.*후광|후광.*스텐/, 'stenBack'],
  [/오사이/, 'galvaOsai'],
  [/캡/, 'galvaCap'],
];

/**
 * 잔넬 계산 — 피스 단위(개수=사용자 수량). 종류=코드, 사이즈=규격(등록값 스냅), 한/영=품목(needsLang 종류만).
 * 코드가 특정 종류로 명확할 때만 계산(모호하면 미지원 → 자동 안 함).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeChannel(calc: any, code: string, item: string, spec: string): CalcResult | CalcError {
  const ch = calc?.channel;
  if (!ch) return { ok: false, message: '잔넬 단가표가 없어요.' };
  const s = (code || '').toLowerCase().replace(/\s/g, '');
  const hasKo = /[가-힣]/.test(item);
  let key: string | null = null;
  for (const [re, k] of CH_TYPE_RULES) {
    if (re.test(s)) {
      key = k;
      break;
    }
  }
  if (!key && /후광/.test(s)) key = hasKo ? 'galvaBackKor' : 'galvaBackEng';
  if (!key) {
    return { ok: false, message: '잔넬 종류를 코드에 구체적으로 적어주세요(타카/오사이/후광/일체형/골드스텐/알미늄캡 등).' };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const type = ch.types.find((t: any) => t.key === key);
  if (!type) return { ok: false, message: '잔넬 종류를 찾을 수 없어요.' };
  const mm = sizeFromSpec(spec);
  if (!mm) return { ok: false, message: '규격에 사이즈(mm)를 입력하세요.' };
  const size = snapSize(channelSizeList(ch.sizeAxis), mm);
  const lang = hasKo ? 'kor' : 'eng';
  const unit = type.needsLang ? type.pricesByLang?.[lang]?.[String(size)] : type.prices?.[String(size)];
  if (unit == null) return { ok: false, message: `잔넬 ${type.label} ${size}mm 단가가 표에 없어요.` };
  return {
    ok: true,
    unit,
    qty: 1,
    perPiece: true,
    desc: `잔넬 ${type.label} ${size}mm${type.needsLang ? (hasKo ? ' · 한글' : ' · 영문') : ''}`,
  };
}
