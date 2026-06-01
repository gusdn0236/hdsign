import { describe, it, expect } from 'vitest';
import {
  diceCoefficient,
  brandMatches,
  similaritySearch,
} from './similarity';
import type { CorpusItem } from './types';

describe('diceCoefficient', () => {
  it('is 1 for identical non-empty strings and 0 for disjoint', () => {
    expect(diceCoefficient('아크릴', '아크릴')).toBe(1);
    expect(diceCoefficient('abcd', 'wxyz')).toBe(0);
  });

  it('is order-independent and scores partial overlap between 0 and 1', () => {
    const s = diceCoefficient('갈바채널', '채널갈바');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe('brandMatches — identity filter', () => {
  const item: CorpusItem = {
    category: '아크릴',
    name: '아크릴 간판',
    brand: '(주)진성커뮤니티',
    unitPrice: 50000,
  };

  it('matches the same brand identity across company forms', () => {
    expect(brandMatches('진성', item)).toBe(true);
  });

  it('rejects a different brand', () => {
    expect(brandMatches('현대', item)).toBe(false);
  });

  it('keeps everything when no brand is supplied', () => {
    expect(brandMatches('', item)).toBe(true);
  });
});

describe('similaritySearch', () => {
  const corpus: CorpusItem[] = [
    {
      id: 'inv-1',
      category: '갈바·스텐·채널·후렘',
      name: '갈바 채널',
      width: 3000,
      height: 600,
      unitPrice: 200000,
      source: 'invoice',
    },
    {
      id: 'pt-1',
      category: '갈바·스텐·채널·후렘',
      name: '갈바 채널',
      width: 3000,
      height: 600,
      unitPrice: 150000,
      source: 'price-table',
    },
  ];

  it('ranks the invoice ground truth above a price-table row on conflict', () => {
    const matches = similaritySearch(
      { name: '갈바 채널', width: 3000, height: 600 },
      corpus,
    );
    expect(matches[0].source).toBe('invoice');
    expect(matches[0].unitPrice).toBe(200000);
  });

  it('applies brandText only as an identity filter (no score effect)', () => {
    const branded: CorpusItem[] = [
      { ...corpus[0], brand: '롯데' },
      { ...corpus[1], id: 'inv-2', brand: '신세계', source: 'invoice' },
    ];
    const matches = similaritySearch(
      { name: '갈바 채널', width: 3000, height: 600, brandText: '롯데' },
      branded,
    );
    // only the 롯데 line survives the identity filter.
    expect(matches).toHaveLength(1);
    expect(matches[0].brand).toBe('롯데');
  });
});
