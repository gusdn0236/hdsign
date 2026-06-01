import { describe, it, expect } from 'vitest';
import { scoreConfidence, isLowConfidence } from './confidence';

describe('scoreConfidence', () => {
  it('is high for a staff correction (top prior)', () => {
    expect(
      scoreConfidence({
        tier: 'correction',
        matchCount: 0,
        minSizeDelta: Infinity,
        parametric: false,
        unknownCategory: false,
      }),
    ).toBe('high');
  });

  it('is high for a size-close history match (tier ①, <10% delta)', () => {
    expect(
      scoreConfidence({
        tier: '①',
        matchCount: 3,
        minSizeDelta: 0.02,
        parametric: true,
        unknownCategory: false,
      }),
    ).toBe('high');
  });

  it('is mid for history with no size-close match', () => {
    expect(
      scoreConfidence({
        tier: '①',
        matchCount: 1,
        minSizeDelta: 0.5,
        parametric: true,
        unknownCategory: false,
      }),
    ).toBe('mid');
  });

  it('is mid for a parametric size-curve estimate on a known category', () => {
    expect(
      scoreConfidence({
        tier: '②',
        matchCount: 0,
        minSizeDelta: Infinity,
        parametric: true,
        unknownCategory: false,
      }),
    ).toBe('mid');
  });

  it('is low for a flat-median fallback and for an unknown category', () => {
    expect(
      scoreConfidence({
        tier: '③',
        matchCount: 0,
        minSizeDelta: Infinity,
        parametric: false,
        unknownCategory: false,
      }),
    ).toBe('low');
    expect(
      scoreConfidence({
        tier: '③',
        matchCount: 0,
        minSizeDelta: Infinity,
        parametric: true,
        unknownCategory: true,
      }),
    ).toBe('low');
  });

  it('isLowConfidence flags only the low score', () => {
    expect(isLowConfidence('low')).toBe(true);
    expect(isLowConfidence('mid')).toBe(false);
    expect(isLowConfidence('high')).toBe(false);
  });
});
