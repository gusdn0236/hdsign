import type { SpecParse } from './types';

/**
 * Name + size + coats normalization for the auto-quote engine.
 * Ported from tenet-test/web engine `normalize.ts`, with the HD사인 domain
 * coat rule added (knowledge 2026-05-31_domain-n-do-paint-means-n-coats):
 * "N도 도장" = N paint coats (1회=1도). Real coat counts are small integers
 * (1..7). "90도"/"45도" are bend angles; "200도"/"700도" are extraction noise,
 * not coats. The engine must reject implausible coat counts and surface a warning
 * instead of pricing them as paint.
 */

/** Legal-entity markers removed during normalization (knowledge §1/§6). */
const LEGAL_MARKERS = /\(주\)|주식회사|㈜|\(유\)|유한회사/g;

/** Brand-alias suffixes dropped when comparing brand identity (knowledge §6). */
const BRAND_SUFFIXES = /(광고|디자인|애드컴|그래픽|기획|커뮤니티|애드|ad)$/i;

/**
 * Normalize a product/brand/customer name for fuzzy matching: strip legal-entity
 * markers, collapse whitespace, lowercase, and canonicalize the thickness unit
 * (`티` → `t`). Keep the original name separately for display.
 */
export function normalize(name: string): string {
  if (!name) return '';
  let s = name.replace(LEGAL_MARKERS, ' ');
  s = s.toLowerCase();
  s = s.replace(/(\d+(?:\.\d+)?)\s*티/g, '$1t');
  s = s.replace(/(\d+(?:\.\d+)?)\s*t\b/g, '$1t');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Normalize a brand string for identity comparison only: {@link normalize} plus
 * dropping company-form suffixes so `진성` and `(주)진성커뮤니티` collapse together
 * (knowledge §6). Brand is an identity filter, never a price input.
 */
export function normalizeBrand(brand?: string): string {
  if (!brand) return '';
  let s = normalize(brand);
  s = s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(BRAND_SUFFIXES, '').trim();
  return s;
}

/** How a raw 도수 value was interpreted by {@link interpretCoats}. */
export type CoatInterpretation =
  | 'none'
  | 'coats'
  | 'bend-angle'
  | 'implausible';

export interface CoatResult {
  /** Plausible coat count (1..7) or undefined when not paintable. */
  coats?: number;
  interpretation: CoatInterpretation;
  /** Set when the input was NOT usable as a coat count. */
  warning?: string;
}

/** Largest realistic paint coat count (knowledge: measured 1..7). */
export const MAX_PLAUSIBLE_COATS = 7;
/** Values commonly meaning a bend angle, not coats (절곡 각도). */
export const BEND_ANGLES = new Set([45, 90]);

/**
 * Interpret a raw 도수 number under the N도 = N coats domain rule.
 *  - `undefined`/`0`         → `none` (no painting)
 *  - `1..7`                  → `coats` (priced as paint)
 *  - `45` / `90`             → `bend-angle` (NOT coats; warn, do not price as paint)
 *  - anything else (8, 200…) → `implausible` (likely a typo/extraction error; warn)
 *
 * Only `coats` yields a paint surcharge downstream; every other branch returns
 * `coats: undefined` plus a warning so the UI can show a coat-warning rather than
 * ballooning the price as if e.g. 90 coats were applied.
 */
export function interpretCoats(raw?: number | null): CoatResult {
  if (raw == null || raw === 0) return { interpretation: 'none' };
  if (!Number.isFinite(raw)) {
    return { interpretation: 'implausible', warning: '도수 값이 올바르지 않습니다.' };
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return {
      interpretation: 'implausible',
      warning: `도수는 정수여야 합니다 (입력: ${raw}).`,
    };
  }
  if (raw >= 1 && raw <= MAX_PLAUSIBLE_COATS) {
    return { coats: raw, interpretation: 'coats' };
  }
  if (BEND_ANGLES.has(raw)) {
    return {
      interpretation: 'bend-angle',
      warning: `${raw}는 도장 도수가 아니라 절곡 각도로 보입니다 — 도장으로 계산하지 않았습니다.`,
    };
  }
  return {
    interpretation: 'implausible',
    warning: `도수 ${raw}는 비현실적입니다 (정상 1~${MAX_PLAUSIBLE_COATS}도). 도장으로 계산하지 않았습니다.`,
  };
}

function toMm(value: number, unit?: string): number {
  return unit === 'cm' ? value * 10 : value;
}

/**
 * Parse a size spec into millimetres. Handles labeled (`W3000 x H600`, `H:650`),
 * unlabeled (`2700*900`, `3000 × 600`), and bare-number (`650` → height, 글자/채널
 * 높이) forms, with optional mm/cm units (default mm). `area` is set only when
 * both dimensions are present.
 */
export function parseSpec(spec?: string): SpecParse {
  if (!spec) return {};
  const s = spec.trim();
  if (!s) return {};

  let width: number | undefined;
  let height: number | undefined;

  const wMatch = s.match(/w\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/i);
  const hMatch = s.match(/h\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/i);
  if (wMatch) width = toMm(parseFloat(wMatch[1]), wMatch[2]?.toLowerCase());
  if (hMatch) height = toMm(parseFloat(hMatch[1]), hMatch[2]?.toLowerCase());

  if (width === undefined && height === undefined) {
    const m = s.match(
      /(\d+(?:\.\d+)?)\s*(mm|cm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/i,
    );
    if (m) {
      width = toMm(parseFloat(m[1]), m[2]?.toLowerCase());
      height = toMm(parseFloat(m[3]), m[4]?.toLowerCase());
    }
  }

  if (width === undefined && height === undefined) {
    const bare = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm)?$/);
    if (bare) height = toMm(parseFloat(bare[1]), bare[2]?.toLowerCase());
  }

  const out: SpecParse = {};
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (width !== undefined && height !== undefined) out.area = width * height;
  return out;
}

/** Build a {@link SpecParse} from explicit w/h (mm), filling area when both exist. */
export function dimsFrom(w?: number, h?: number): SpecParse {
  const out: SpecParse = {};
  if (w != null && Number.isFinite(w)) out.width = w;
  if (h != null && Number.isFinite(h)) out.height = h;
  if (out.width != null && out.height != null) out.area = out.width * out.height;
  return out;
}

/** Size-band width in millimetres for {@link sizeBucket} (100mm bands). */
export const SIZE_BUCKET_BAND_MM = 100;

/**
 * Canonical size-bucket token for a line's dimensions.
 *
 * This is the SHARED contract between the engine and the corrections UI: a staff
 * correction's `featureKey` is `${category}::${sizeBucket(line)}`, so the engine's
 * {@link findCorrection} and the slice-3 corrections UI (which builds the key when
 * POSTing a correction) MUST compute the token the same way — import this helper
 * on both sides rather than re-deriving it, or a correction will silently apply to
 * the wrong size.
 *
 * Scheme: a 100mm **height** band (channel/갈바 signs are priced by height — see
 * the linear size curve in pricing.ts), labelled `h{band}` — e.g. h=600mm → "h600",
 * h=620 → "h600", h=300 → "h300". When only width is known we fall back to a
 * width band `w{band}`; when neither dimension is present the bucket is "na"
 * (size-agnostic). Deterministic: same dimensions always yield the same token.
 */
export function sizeBucket(dims: { w?: number; h?: number }): string {
  const band = (v: number) =>
    Math.round(v / SIZE_BUCKET_BAND_MM) * SIZE_BUCKET_BAND_MM;
  if (dims.h != null && Number.isFinite(dims.h)) return `h${band(dims.h)}`;
  if (dims.w != null && Number.isFinite(dims.w)) return `w${band(dims.w)}`;
  return 'na';
}
