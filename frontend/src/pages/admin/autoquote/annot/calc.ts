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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CALC: any = { acryl: ALL_CALC.acryl, gomu: ALL_CALC.gomu };

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

/** 품목코드 → 계산기 종류 + 두께(예: 아크릴3T → {calc:'acryl', tk:'3T'}). */
export function parseCode(code: string): ParsedCode | null {
  const s = (code || '').toLowerCase().replace(/\s/g, '');
  let calc: ParsedCode['calc'] | null = null;
  if (/아크릴|포맥스/.test(s)) calc = 'acryl';
  else if (/고무|스카시/.test(s)) calc = 'gomu';
  else if (/에폭시|갈바|스텐/.test(s)) calc = 'epoxy';
  else if (/잔넬|채널|channel/.test(s)) calc = 'channel';
  else if (/금경|은경|금은/.test(s)) calc = 'goldsilver';
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
