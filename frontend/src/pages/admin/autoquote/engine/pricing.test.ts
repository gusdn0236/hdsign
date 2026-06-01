import { describe, it, expect } from 'vitest';
import {
  breakdownEstimate,
  resolveCategory,
  paintingSurcharge,
  CATEGORY_MODELS,
  PAINT_BY_COATS,
} from './pricing';

describe('resolveCategory', () => {
  it('resolves canonical keys, UI aliases, and substring signals', () => {
    expect(resolveCategory('갈바·스텐·채널·후렘')).toBe('갈바·스텐·채널·후렘');
    expect(resolveCategory('채널간판')).toBe('갈바·스텐·채널·후렘'); // alias
    expect(resolveCategory('아크릴 5T 글자')).toBe('아크릴'); // substring
  });

  it('returns undefined for an unknown category', () => {
    expect(resolveCategory('우주선')).toBeUndefined();
    expect(resolveCategory(undefined)).toBeUndefined();
  });
});

describe('breakdownEstimate — size curve (tier ②/③)', () => {
  it('uses base + slope·height_cm for a linear category (채널, via alias)', () => {
    // 88000 + 1490 * 60cm = 177400
    const est = breakdownEstimate('채널간판', { height: 600 });
    expect(est).not.toBeNull();
    expect(est!.category).toBe('갈바·스텐·채널·후렘');
    expect(est!.unitPrice).toBe(177400);
    expect(est!.parametric).toBe(true);
    expect(Number.isInteger(est!.unitPrice)).toBe(true);
  });

  it('uses base + slope·height_cm for acrylic (아크릴)', () => {
    // 23000 + 1060 * 60cm = 86600
    expect(breakdownEstimate('아크릴', { height: 600 })!.unitPrice).toBe(86600);
  });

  it('falls back to the flat median when no height is known', () => {
    const est = breakdownEstimate('아크릴', {});
    expect(est!.parametric).toBe(false);
    expect(est!.unitPrice).toBe(CATEGORY_MODELS['아크릴'].median);
  });

  it('returns null for an unresolvable category', () => {
    expect(breakdownEstimate('우주선', { height: 100 })).toBeNull();
  });
});

describe('paintingSurcharge — N도 coat pricing', () => {
  it('prices each plausible coat count from the catalog', () => {
    for (const [n, price] of Object.entries(PAINT_BY_COATS)) {
      expect(paintingSurcharge({ coats: Number(n) })).toBe(price);
    }
  });

  it('uses premium and default fallbacks', () => {
    expect(paintingSurcharge({ premium: true })).toBe(37500);
    expect(paintingSurcharge({})).toBe(30000);
  });
});
