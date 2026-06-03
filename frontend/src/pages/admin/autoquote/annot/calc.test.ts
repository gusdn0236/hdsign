import { describe, it, expect } from 'vitest';
import {
  num,
  sizev,
  acrylBand,
  gomuBand,
  parseCode,
  sizeFromSpec,
  charCount,
  ksim,
  typeKey,
  szClose,
  computeAcryl,
  computeGomu,
} from './calc';

// 테스트용 소형 단가표(실 prices.json 대신 결정적 fixture).
const CALC = {
  acryl: { prices: { '3T': { 한글: { '~30': 480, '91~100': 1200 }, 영문: { '91~100': 900 } } } },
  gomu: { prices: { '10T': { '~149': 3500, '150~199': 4200 } } },
};

describe('num / sizev', () => {
  it('num 은 숫자만 추출', () => {
    expect(num('15,000원')).toBe(15000);
    expect(num('abc')).toBeNull();
    expect(num(null)).toBeNull();
  });
  it('sizev: AxB=면적, h:NNN=높이², 단일=²', () => {
    expect(sizev('300x200')).toBe(60000);
    expect(sizev('300*200')).toBe(60000);
    expect(sizev('h:120')).toBe(14400);
    expect(sizev('150')).toBe(22500);
    expect(sizev('')).toBeNull();
  });
  it('sizev 큰 값 오버플로 없음(double)', () => {
    expect(sizev('50000x50000')).toBe(2500000000);
  });
});

describe('밴드', () => {
  it('acrylBand', () => {
    expect(acrylBand(20)).toBe('~30');
    expect(acrylBand(30)).toBe('~30');
    expect(acrylBand(31)).toBe('31~40');
    expect(acrylBand(100)).toBe('91~100');
  });
  it('gomuBand', () => {
    expect(gomuBand(100)).toBe('~149');
    expect(gomuBand(150)).toBe('150~199');
    expect(gomuBand(200)).toBe('200~249');
    expect(gomuBand(2500)).toBeNull();
  });
});

describe('parseCode', () => {
  it('아크릴/포맥스 → acryl + 두께', () => {
    expect(parseCode('아크릴3T')).toEqual({ calc: 'acryl', tk: '3T' });
    expect(parseCode('포맥스 5T')).toEqual({ calc: 'acryl', tk: '5T' });
  });
  it('고무스카시 → gomu', () => {
    expect(parseCode('고무스카시10T')).toEqual({ calc: 'gomu', tk: '10T' });
  });
  it('잔넬/채널 계열 → channel', () => {
    expect(parseCode('잔넬')).toEqual({ calc: 'channel', tk: null });
  });
  it('인식 불가 → null', () => {
    expect(parseCode('시트컷팅')).toBeNull(); // 어떤 계산기 패턴에도 안 걸림
    expect(parseCode('xyz')).toBeNull();
  });
});

describe('charCount / sizeFromSpec', () => {
  it('charCount 모드별', () => {
    expect(charCount('가나다 ABC', 'ko')).toBe(3);
    expect(charCount('가나다 ABC', 'en')).toBe(3);
    expect(charCount('가나다 ABC', 'all')).toBe(6);
  });
  it('sizeFromSpec', () => {
    expect(sizeFromSpec('H100')).toBe(100);
    expect(sizeFromSpec('규격없음')).toBeNull();
  });
});

describe('typeKey / ksim / szClose', () => {
  it('유형 유사: 부분일치/앞3글자', () => {
    expect(ksim(typeKey('갈바레이져타공'), typeKey('갈바레이져'))).toBe(true); // 부분일치
    expect(ksim(typeKey('갈바레이저'), typeKey('갈바레이져'))).toBe(true); // 앞3글자
    expect(ksim(typeKey('에폭시'), typeKey('갈바레이져'))).toBe(false);
  });
  it('szClose 0~1', () => {
    expect(szClose(100, 100)).toBe(1);
    expect(szClose(50, 100)).toBe(0.5);
    expect(szClose(100, null)).toBe(0);
  });
});

describe('computeAcryl', () => {
  it('한글 단가 × 글자수', () => {
    const r = computeAcryl(CALC, '3T', '한글', '가나다', 'H100', 'ko');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unit).toBe(1200);
      expect(r.qty).toBe(3);
    }
  });
  it('두께 없으면 에러', () => {
    const r = computeAcryl(CALC, '', '한글', '가', 'H100', 'ko');
    expect(r.ok).toBe(false);
  });
  it('밴드에 단가 없으면 에러', () => {
    const r = computeAcryl(CALC, '3T', '한글', '가', 'H40', 'ko'); // 31~40 밴드 미등록
    expect(r.ok).toBe(false);
  });
  it('규격 없으면 에러', () => {
    const r = computeAcryl(CALC, '3T', '한글', '가', '', 'ko');
    expect(r.ok).toBe(false);
  });
});

describe('computeGomu', () => {
  it('밴드 단가 × 글자수', () => {
    const r = computeGomu(CALC, '10T', 'ABC가', 'H100');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unit).toBe(3500);
      expect(r.qty).toBe(4);
    }
  });
  it('단가표 없으면 에러', () => {
    const r = computeGomu(CALC, '99T', '가', 'H100');
    expect(r.ok).toBe(false);
  });
});
