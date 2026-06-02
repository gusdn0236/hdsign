import { describe, it, expect } from 'vitest';
import {
  normalize,
  normalizeBrand,
  parseSpec,
  dimsFrom,
  interpretCoats,
  MAX_PLAUSIBLE_COATS,
} from './normalize';

describe('normalize', () => {
  it('strips legal markers, lowercases, collapses whitespace', () => {
    expect(normalize('(주) 현대  애드')).toBe('현대 애드');
    expect(normalize('주식회사ABC')).toBe('abc');
  });

  it('canonicalizes the thickness unit 티 → t', () => {
    expect(normalize('아크릴 5티')).toBe('아크릴 5t');
    expect(normalize('아크릴 5 T')).toBe('아크릴 5t');
  });

  it('returns empty string for empty input', () => {
    expect(normalize('')).toBe('');
  });
});

describe('normalizeBrand', () => {
  it('collapses company forms and brand suffixes to a bare identity', () => {
    // (주)진성커뮤니티 → 진성 (커뮤니티 suffix + legal markers dropped)
    expect(normalizeBrand('(주)진성커뮤니티')).toBe('진성');
    expect(normalizeBrand('진성')).toBe('진성');
  });

  it('returns empty string for no brand', () => {
    expect(normalizeBrand(undefined)).toBe('');
  });
});

describe('parseSpec', () => {
  it('parses labeled W×H', () => {
    expect(parseSpec('W3000 x H600')).toEqual({
      width: 3000,
      height: 600,
      area: 1_800_000,
    });
  });

  it('parses unlabeled a*b and applies cm units', () => {
    expect(parseSpec('270cm*90cm')).toEqual({
      width: 2700,
      height: 900,
      area: 2_430_000,
    });
  });

  it('treats a bare number as a height (글자/채널 높이)', () => {
    expect(parseSpec('650')).toEqual({ height: 650 });
  });

  it('returns empty for missing/blank spec', () => {
    expect(parseSpec()).toEqual({});
    expect(parseSpec('   ')).toEqual({});
  });
});

describe('dimsFrom', () => {
  it('fills area only when both dimensions present', () => {
    expect(dimsFrom(100, 200)).toEqual({
      width: 100,
      height: 200,
      area: 20000,
    });
    expect(dimsFrom(undefined, 200)).toEqual({ height: 200 });
    expect(dimsFrom()).toEqual({});
  });
});

describe('interpretCoats — N도 = N paint coats domain rule', () => {
  it('accepts plausible coat counts 1..7 as coats', () => {
    for (let n = 1; n <= MAX_PLAUSIBLE_COATS; n++) {
      const r = interpretCoats(n);
      expect(r.coats).toBe(n);
      expect(r.interpretation).toBe('coats');
      expect(r.warning).toBeUndefined();
    }
  });

  it('treats 90 and 45 as a BEND ANGLE, never coats, and warns', () => {
    for (const angle of [45, 90]) {
      const r = interpretCoats(angle);
      expect(r.coats).toBeUndefined();
      expect(r.interpretation).toBe('bend-angle');
      expect(r.warning).toBeTruthy();
    }
  });

  it('rejects implausible coat counts (200, 700, 8) with a warning', () => {
    for (const bad of [8, 200, 700]) {
      const r = interpretCoats(bad);
      expect(r.coats).toBeUndefined();
      expect(r.interpretation).toBe('implausible');
      expect(r.warning).toBeTruthy();
    }
  });

  it('treats missing / zero as no painting (no warning)', () => {
    expect(interpretCoats(undefined)).toEqual({ interpretation: 'none' });
    expect(interpretCoats(0)).toEqual({ interpretation: 'none' });
  });

  it('rejects non-integer / negative as implausible', () => {
    expect(interpretCoats(2.5).interpretation).toBe('implausible');
    expect(interpretCoats(-1).interpretation).toBe('implausible');
  });
});
