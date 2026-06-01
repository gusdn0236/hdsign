import type { Confidence } from './types';

/**
 * Confidence scoring for a single priced line (ported/adapted from
 * tenet-test/web engine `confidence.ts`). Driven by which hierarchy tier produced
 * the price and how close the supporting evidence is.
 */

/** Size delta (relative area) below which a history match is "size-close". */
export const SIZE_DELTA_HIGH = 0.1;

export interface ConfidenceInput {
  /** Hierarchy tier that produced the price. */
  tier: '①' | '②' | '③' | 'correction';
  /** Number of supporting history matches (after brand filter). */
  matchCount: number;
  /** Smallest relative size delta among matches (Infinity if none/unknown). */
  minSizeDelta: number;
  /** True when a real size curve (parametric, height-driven) was used. */
  parametric: boolean;
  /** True when the category could not be resolved at all. */
  unknownCategory: boolean;
}

/**
 * Score line confidence:
 *  - `high` — a staff correction, or a size-close history match
 *    (≥1 match within 10% size delta).
 *  - `mid`  — some history support, or a parametric size-curve estimate on a
 *    known category.
 *  - `low`  — flat-median fallback or an unresolved category (UI shows a
 *    low-confidence flag).
 */
export function scoreConfidence(input: ConfidenceInput): Confidence {
  if (input.tier === 'correction') return 'high';
  if (input.unknownCategory) return 'low';

  if (input.tier === '①' && input.matchCount > 0) {
    return input.minSizeDelta < SIZE_DELTA_HIGH ? 'high' : 'mid';
  }
  // tier ② / ③ size curve.
  return input.parametric ? 'mid' : 'low';
}

/** Convenience: a line is low-confidence iff its score is `low`. */
export function isLowConfidence(c: Confidence): boolean {
  return c === 'low';
}
