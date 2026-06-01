import type { SpecParse } from './types';

/**
 * Category pricing models + surcharge catalog (ported from tenet-test/web engine
 * `pricing.ts`; constants from knowledge 2026-05-30_pricing-normalization §2–§4).
 * Pure functions only — given a category + size they return integer won, with no
 * I/O. These power tier ②/③ of the hierarchy (size curve, category median); tier
 * ① (history) is resolved against the corpus in `estimate.ts`.
 */

/** Per-category model (knowledge §2). */
export interface CategoryModel {
  /** `linear` = base + slope·height_cm; `flat` = median unit price. */
  model: 'linear' | 'flat';
  base?: number;
  slopePerCm?: number;
  /** Median/representative unit price, integer won. */
  median: number;
}

/** Canonical category → pricing model (knowledge §1 standard categories). */
export const CATEGORY_MODELS: Record<string, CategoryModel> = {
  아크릴: { model: 'linear', base: 23000, slopePerCm: 1060, median: 45000 },
  '갈바·스텐·채널·후렘': {
    model: 'linear',
    base: 88000,
    slopePerCm: 1490,
    median: 130000,
  },
  에폭시: { model: 'linear', base: 80000, slopePerCm: 3420, median: 120000 },
  'LED/네온/조명': { model: 'flat', median: 650 },
  '전원/파워서플라이': { model: 'flat', median: 23000 },
  '조립/노무': { model: 'flat', median: 160000 },
  도장: { model: 'flat', median: 30000 },
  '시트/실사/인쇄': { model: 'flat', median: 35000 },
  포맥스: { model: 'flat', median: 40000 },
  '박스/조명박스': { model: 'flat', median: 50000 },
  '로고/도안/디자인': { model: 'flat', median: 30000 },
  '시공/부착': { model: 'flat', median: 50000 },
  '배송/퀵/운반': { model: 'flat', median: 25000 },
  '할인/DC': { model: 'flat', median: -7627 },
};

/** UI/work-order labels → canonical model keys. */
const CATEGORY_ALIASES: Record<string, string> = {
  채널간판: '갈바·스텐·채널·후렘',
  채널: '갈바·스텐·채널·후렘',
  잔넬: '갈바·스텐·채널·후렘',
  타카잔넬: '갈바·스텐·채널·후렘',
  갈바: '갈바·스텐·채널·후렘',
  스텐: '갈바·스텐·채널·후렘',
  후렘: '갈바·스텐·채널·후렘',
  스카시: '갈바·스텐·채널·후렘',
  아크릴간판: '아크릴',
  엘이디: 'LED/네온/조명',
  led: 'LED/네온/조명',
  네온: 'LED/네온/조명',
  조명: 'LED/네온/조명',
  모듈: 'LED/네온/조명',
  전원: '전원/파워서플라이',
  파워: '전원/파워서플라이',
  smps: '전원/파워서플라이',
  조립: '조립/노무',
  완조립: '조립/노무',
  노무: '조립/노무',
  시트: '시트/실사/인쇄',
  실사: '시트/실사/인쇄',
  인쇄: '시트/실사/인쇄',
  배송: '배송/퀵/운반',
  퀵: '배송/퀵/운반',
  로고: '로고/도안/디자인',
  도안: '로고/도안/디자인',
  디자인: '로고/도안/디자인',
  시공: '시공/부착',
  부착: '시공/부착',
  박스: '박스/조명박스',
  할인: '할인/DC',
  dc: '할인/DC',
};

/** Substring signals → canonical category (knowledge §1 map). */
const DETECT_SIGNALS: Array<[RegExp, string]> = [
  [/아크릴|[0-9]+\s*t\b/i, '아크릴'],
  [/갈바|스텐|잔넬|채널|후렘|후레임|스카시/, '갈바·스텐·채널·후렘'],
  [/에폭시/, '에폭시'],
  [/smd네온|apl|kpl|mkdl|kdl|로웬|인터원|위즈|넘버원|모듈|광각|it-3s|네온|led/i, 'LED/네온/조명'],
  [/유니온|hm-|ss-wsp|smps|파워|타이머|조광|트랜스/i, '전원/파워서플라이'],
  [/완조립|조립|노무/, '조립/노무'],
  [/도장/, '도장'],
  [/시트|실사|인쇄|컷팅/, '시트/실사/인쇄'],
  [/포맥스/, '포맥스'],
  [/박스/, '박스/조명박스'],
  [/로고|도안|현도|마크|디자인/, '로고/도안/디자인'],
  [/시공|부착|까치발/, '시공/부착'],
  [/퀵|택배|배송|화물|다마스/, '배송/퀵/운반'],
  [/할인|네고|\bdc\b/i, '할인/DC'],
];

/**
 * Resolve a free-form category/label to a canonical {@link CategoryModel} key:
 * exact key → alias table → substring detection. Returns `undefined` when nothing
 * matches (caller falls back to a low-confidence estimate).
 */
export function resolveCategory(category?: string): string | undefined {
  if (!category) return undefined;
  const raw = category.trim();
  if (CATEGORY_MODELS[raw]) return raw;
  const lower = raw.toLowerCase();
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  if (CATEGORY_ALIASES[raw]) return CATEGORY_ALIASES[raw];
  for (const [re, canon] of DETECT_SIGNALS) {
    if (re.test(raw)) return canon;
  }
  return undefined;
}

export interface BreakdownResult {
  category: string;
  /** Estimated unit price, integer won. */
  unitPrice: number;
  /** True when the parametric linear-height model was used (vs flat median). */
  parametric: boolean;
  heightCm?: number;
}

/**
 * Per-piece size-curve estimate (knowledge §2): `base + slope·height_cm` for
 * linear categories (아크릴, 갈바·스텐·채널·후렘, 에폭시) when a height is known,
 * otherwise the category flat median. `category` may be any label — it is resolved
 * to a canonical model first. Returns `null` for unresolvable categories.
 */
export function breakdownEstimate(
  category: string,
  dims: SpecParse,
  models: Record<string, CategoryModel> = CATEGORY_MODELS,
): BreakdownResult | null {
  const canon = resolveCategory(category);
  const m = canon ? models[canon] : undefined;
  if (!canon || !m) return null;
  const heightCm = dims.height != null ? dims.height / 10 : undefined;
  if (
    m.model === 'linear' &&
    m.base != null &&
    m.slopePerCm != null &&
    heightCm != null
  ) {
    return {
      category: canon,
      unitPrice: Math.round(m.base + m.slopePerCm * heightCm),
      parametric: true,
      heightCm,
    };
  }
  return {
    category: canon,
    unitPrice: Math.round(m.median),
    parametric: false,
    heightCm,
  };
}

// --- Surcharge catalog (knowledge §3) ---

/** 도장: price by coat count (₩). Only plausible coat counts (1..7) are priced. */
export const PAINT_BY_COATS: Record<number, number> = {
  1: 20000,
  2: 40000,
  3: 50000,
  4: 60000,
  5: 90000,
  6: 100000,
  7: 130000,
};
export const PAINT_DEFAULT = 30000;
export const PAINT_PREMIUM = 37500;

/**
 * 도장 surcharge by coat count, premium finish (팬톤/금색), or flat default.
 * `coats` here must already be a validated plausible count (see
 * {@link interpretCoats}); a bend angle / implausible value never reaches this.
 */
export function paintingSurcharge(
  opts: { coats?: number; premium?: boolean } = {},
): number {
  if (opts.premium) return PAINT_PREMIUM;
  if (opts.coats != null && PAINT_BY_COATS[opts.coats] != null) {
    return PAINT_BY_COATS[opts.coats];
  }
  return PAINT_DEFAULT;
}
