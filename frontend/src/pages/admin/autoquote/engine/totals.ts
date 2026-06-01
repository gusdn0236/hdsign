/**
 * Quote totals: line summation, tail discount, and 10% VAT
 * (ported from tenet-test/web engine `totals.ts`; knowledge §4).
 */

/** Supply tail is rounded down to this increment (knowledge §4: 천원단위 절삭). */
export const DISCOUNT_ROUND_TO = 1000;
export const VAT_RATE = 0.1;

/** Anything that contributes an integer-won amount to a quote. */
export interface AmountLine {
  amount: number;
  /** Discount lines are excluded from the "≥1 evidence" rule. */
  kind?: string;
}

export interface DiscountLine {
  description: string;
  /** Negative integer won. */
  amount: number;
  kind: 'discount';
}

/**
 * Tail discount (knowledge §4): round supply **down** to the nearest `roundTo`
 * (₩1,000), as a negative discount line. Returns `null` when supply is already a
 * clean multiple (or roundTo ≤ 0).
 */
export function discountLine(
  supply: number,
  roundTo: number = DISCOUNT_ROUND_TO,
): DiscountLine | null {
  if (roundTo <= 0) return null;
  const target = Math.floor(supply / roundTo) * roundTo;
  const delta = target - supply; // <= 0
  if (delta === 0) return null;
  return { description: '끝자리 할인', amount: delta, kind: 'discount' };
}

export interface Totals {
  /** Sum of all line amounts (integer won, discounts negative). */
  supply: number;
  /** 10% VAT on supply, rounded to the nearest won. */
  vat: number;
  /** supply + vat. */
  total: number;
}

/**
 * Total a quote's lines. Supply is the integer-won sum of line amounts (discount
 * lines are negative); VAT is 10% rounded to the nearest won.
 */
export function computeTotals(lines: AmountLine[]): Totals {
  const supply = lines.reduce((sum, l) => sum + Math.round(l.amount), 0);
  const vat = Math.round(supply * VAT_RATE);
  return { supply, vat, total: supply + vat };
}
