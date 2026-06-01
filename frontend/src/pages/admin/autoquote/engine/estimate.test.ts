import { describe, it, expect } from 'vitest';
import { estimate } from './estimate';
import type { CorpusItem, Correction, EstimateContext } from './types';

// Channel-sign size curve for 1000×500 (height 500mm = 50cm):
//   88000 + 1490·50 = 162500.
const CHANNEL_1000x500 = 162500;
// Channel-sign size curve for 3000×600 (height 600mm = 60cm):
//   88000 + 1490·60 = 177400.
const CHANNEL_3000x600 = 177400;

const channelInvoice: CorpusItem = {
  id: 'inv-100',
  index: 0,
  category: '갈바·스텐·채널·후렘',
  name: '갈바·스텐·채널·후렘',
  width: 3000,
  height: 600,
  unitPrice: 200000, // deliberately ≠ size curve (177400)
  source: 'invoice',
};

function ctx(over: Partial<EstimateContext> = {}): EstimateContext {
  return { corpus: [], ...over };
}

describe('estimate — hierarchy ① history > ③ category+size', () => {
  it('prefers a matched invoice price over the size curve (① beats ③)', () => {
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice] }),
    );
    expect(res.unitPrice).toBe(200000); // history, NOT size curve 177400
    expect(res.evidence[0].type).toBe('history');
    expect(res.evidence[0].tier).toBe('①');
    expect(res.confidence).toBe('high'); // size-close match
  });

  it('falls back to the size curve when there is no history (tier ③)', () => {
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx(),
    );
    expect(res.unitPrice).toBe(CHANNEL_3000x600);
    expect(res.evidence[0].type).toBe('size');
  });

  it('pulls toward invoice ground truth over a conflicting price-table row', () => {
    const priceTable: CorpusItem = {
      ...channelInvoice,
      id: 'pt-1',
      index: 1,
      unitPrice: 150000,
      source: 'price-table',
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [priceTable, channelInvoice] }),
    );
    expect(res.unitPrice).toBe(200000); // invoice wins the conflict
  });
});

describe('estimate — a staff correction is the top prior (> history)', () => {
  it('overrides a matching invoice with the corrected unit price', () => {
    const correction: Correction = {
      id: 'c1',
      category: '채널간판',
      correctedUnitPrice: 99000,
      explanation: '현장 실측 반영',
      author: '김부장',
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [correction] }),
    );
    expect(res.unitPrice).toBe(99000);
    expect(res.evidence[0].type).toBe('correction');
    expect(res.confidence).toBe('high');
  });

  it('matches a correction by featureKey (category::sizeBucket)', () => {
    const correction: Correction = {
      id: 'c2',
      featureKey: '채널간판::h600',
      correctedUnitPrice: 88000,
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [correction] }),
    );
    expect(res.unitPrice).toBe(88000);
    expect(res.evidence[0].type).toBe('correction');
  });

  it('does NOT apply a correction whose brand identity differs (falls to history)', () => {
    const correction: Correction = {
      id: 'c3',
      category: '채널간판',
      brand: 'GS25',
      correctedUnitPrice: 50000,
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1, brandText: '세븐일레븐' },
      ctx({ corpus: [channelInvoice], corrections: [correction] }),
    );
    // 세븐일레븐 ≠ GS25 → correction skipped; no brand history → size curve.
    expect(res.unitPrice).not.toBe(50000);
    expect(res.evidence[0].type).not.toBe('correction');
  });
});

describe('estimate — priority-weighted correction selection (boss > peer)', () => {
  it('a correction beats tier-① history for the same line (S5)', () => {
    const correction: Correction = {
      id: 'c-s5',
      category: '채널간판',
      correctedUnitPrice: 77000,
      author: '박과장',
      explanation: '거래처 단가 협의',
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [correction] }),
    );
    expect(res.unitPrice).toBe(77000); // not history 200000
    expect(res.evidence[0].type).toBe('correction');
    expect(res.evidence[0].tier).toBe('correction');
  });

  it('a higher-priority correction beats a lower-priority one (same featureKey)', () => {
    const peer: Correction = {
      id: 'c-peer',
      featureKey: '채널간판::h600',
      correctedUnitPrice: 60000,
      priority: 1,
      author: '직원A',
      date: '2026-05-30',
    };
    const boss: Correction = {
      id: 'c-boss',
      featureKey: '채널간판::h600',
      correctedUnitPrice: 95000,
      priority: 10,
      author: '김부장',
      date: '2026-05-01', // older, but higher priority must still win
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      // order shuffled so selection cannot rely on array position
      ctx({ corpus: [channelInvoice], corrections: [peer, boss] }),
    );
    expect(res.unitPrice).toBe(95000); // boss override wins on priority
    expect(res.evidence[0].invoiceId).toBe('c-boss');
  });

  it('tie-breaks by the most-recent date when priority is equal', () => {
    const older: Correction = {
      id: 'c-old',
      featureKey: '채널간판::h600',
      correctedUnitPrice: 50000,
      priority: 5,
      date: '2026-04-01',
    };
    const newer: Correction = {
      id: 'c-new',
      featureKey: '채널간판::h600',
      correctedUnitPrice: 82000,
      priority: 5,
      date: '2026-05-31',
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [older, newer] }),
    );
    expect(res.unitPrice).toBe(82000); // newest date wins the tie
    expect(res.evidence[0].invoiceId).toBe('c-new');
  });

  it('ignores a correction whose category does not match the line', () => {
    const wrongCategory: Correction = {
      id: 'c-acrylic',
      category: '아크릴',
      correctedUnitPrice: 11111,
      priority: 99,
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [wrongCategory] }),
    );
    // different category → correction skipped → tier-① history applies.
    expect(res.unitPrice).toBe(200000);
    expect(res.evidence[0].type).toBe('history');
  });

  it('emits correction evidence citing the author and explanation', () => {
    const correction: Correction = {
      id: 'c-note',
      category: '채널간판',
      correctedUnitPrice: 70000,
      priority: 3,
      author: '김부장',
      explanation: '현장 실측 반영',
    };
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1 },
      ctx({ corpus: [channelInvoice], corrections: [correction] }),
    );
    const ev = res.evidence[0];
    expect(ev.type).toBe('correction');
    expect(ev.note).toContain('김부장'); // author cited
    expect(ev.note).toContain('현장 실측 반영'); // explanation carried
    expect(ev.note).toContain('상급자'); // flagged as a shared/boss override
  });
});

describe('estimate — brand_text is an IDENTITY FILTER, not a price predictor', () => {
  it('gives the SAME price for different brands at the same category+size', () => {
    const a = estimate(
      { category: '채널간판', w: 1000, h: 500, qty: 1, brandText: 'GS25' },
      ctx(),
    );
    const b = estimate(
      { category: '채널간판', w: 1000, h: 500, qty: 1, brandText: '세븐일레븐' },
      ctx(),
    );
    expect(a.unitPrice).toBe(CHANNEL_1000x500);
    expect(b.unitPrice).toBe(CHANNEL_1000x500);
    expect(a.unitPrice).toBe(b.unitPrice); // brand string never moves the number
  });

  it('uses brand only to narrow WHICH history matches, never the price itself', () => {
    const gsLine: CorpusItem = {
      id: 'inv-gs',
      index: 0,
      category: '갈바·스텐·채널·후렘',
      name: '갈바·스텐·채널·후렘',
      brand: 'GS25',
      width: 3000,
      height: 600,
      unitPrice: 210000,
      source: 'invoice',
    };
    // brand '세븐일레븐' is filtered out of GS25's history → size curve fallback.
    const other = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1, brandText: '세븐일레븐' },
      ctx({ corpus: [gsLine] }),
    );
    expect(other.unitPrice).toBe(CHANNEL_3000x600); // not GS25's 210000
    expect(other.evidence[0].tier).toBe('②'); // brand-cohort size curve

    // GS25 matches its own history.
    const gs = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 1, brandText: 'GS25' },
      ctx({ corpus: [gsLine] }),
    );
    expect(gs.unitPrice).toBe(210000);
    expect(gs.evidence[0].type).toBe('history');
  });
});

describe('estimate — N도 = N paint coats domain rule', () => {
  it('adds a paint surcharge for a plausible coat count', () => {
    const base = estimate({ category: '채널간판', w: 1000, h: 500, qty: 1 }, ctx());
    const painted = estimate(
      { category: '채널간판', w: 1000, h: 500, coats: 2, qty: 1 },
      ctx(),
    );
    expect(painted.unitPrice).toBe(base.unitPrice + 40000); // 2도 = +40,000
    expect(painted.coatWarning).toBeUndefined();
  });

  it('treats 90 as a bend angle: warns and does NOT balloon the price', () => {
    const res = estimate(
      { category: '채널간판', w: 1000, h: 500, coats: 90, qty: 1 },
      ctx(),
    );
    expect(res.coatWarning).toBeTruthy();
    expect(res.unitPrice).toBe(CHANNEL_1000x500); // no paint applied at all
  });

  it('treats an implausible count (200) as a warning, not 200 coats', () => {
    const res = estimate(
      { category: '채널간판', w: 1000, h: 500, coats: 200, qty: 1 },
      ctx(),
    );
    expect(res.coatWarning).toBeTruthy();
    expect(res.unitPrice).toBe(CHANNEL_1000x500);
  });
});

describe('estimate — evidence & totals invariants', () => {
  it('every non-discount result carries ≥1 evidence ref', () => {
    const inputs = [
      { category: '채널간판', w: 3000, h: 600, qty: 1 }, // size curve
      { category: '채널간판', w: 3000, h: 600, qty: 1, brandText: 'A' }, // tier ②
      { category: '아크릴', w: 1000, h: 200, qty: 2 }, // acrylic
      { category: '우주선', w: 100, h: 100, qty: 1 }, // unknown
    ];
    for (const line of inputs) {
      const res = estimate(line, ctx({ corpus: [channelInvoice] }));
      expect(res.evidence.length).toBeGreaterThanOrEqual(1);
      expect(res.evidence[0].note).toBeTruthy();
    }
  });

  it('multiplies qty into the line total', () => {
    const res = estimate(
      { category: '채널간판', w: 3000, h: 600, qty: 3 },
      ctx(),
    );
    expect(res.total).toBe(res.unitPrice * 3);
    expect(res.total).toBe(CHANNEL_3000x600 * 3);
  });

  it('flags an unknown category as low confidence with priceless fallback', () => {
    const res = estimate({ category: '우주선', w: 100, h: 100, qty: 1 }, ctx());
    expect(res.confidence).toBe('low');
    expect(res.lowConfidence).toBe(true);
    expect(res.unitPrice).toBe(0);
    expect(res.evidence[0].type).toBe('category');
  });
});
