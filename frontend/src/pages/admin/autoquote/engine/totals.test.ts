import { describe, it, expect } from 'vitest';
import { computeTotals, discountLine, VAT_RATE } from './totals';

describe('computeTotals — VAT 10%', () => {
  it('sums line amounts and adds 10% VAT', () => {
    const t = computeTotals([{ amount: 100000 }, { amount: 77400 }]);
    expect(t.supply).toBe(177400);
    expect(t.vat).toBe(Math.round(177400 * VAT_RATE)); // 17740
    expect(t.vat).toBe(17740);
    expect(t.total).toBe(195140);
  });

  it('includes negative discount lines in the supply', () => {
    const t = computeTotals([{ amount: 100000 }, { amount: -627, kind: 'discount' }]);
    expect(t.supply).toBe(99373);
    expect(t.total).toBe(99373 + Math.round(99373 * VAT_RATE));
  });

  it('rounds VAT to the nearest won', () => {
    const t = computeTotals([{ amount: 12345 }]);
    expect(t.vat).toBe(1235); // round(1234.5)
  });
});

describe('discountLine — 끝자리 천원단위 절삭', () => {
  it('rounds supply down to the nearest 1,000 as a negative line', () => {
    const d = discountLine(177627);
    expect(d).not.toBeNull();
    expect(d!.amount).toBe(-627); // 177627 → 177000
    expect(d!.kind).toBe('discount');
  });

  it('returns null when supply is already a clean multiple', () => {
    expect(discountLine(177000)).toBeNull();
  });
});
