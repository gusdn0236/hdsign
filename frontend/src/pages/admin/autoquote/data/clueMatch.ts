/**
 * [이지폼에서 찾기] 로 주문번호를 못 찾았을 때 — 사람이 넣은 단서(작업내용·규격 등)로 명세서 고르기.
 *
 * 흔한 단서(고무스카시20T·도장)는 수많은 명세서에 들어 있어 다 넣으면 그런 명세서가 우르르 나온다.
 * 그래서 **훑은 명세서들 안에서 그 단서가 몇 건에 나오는지(df)** 로 무게를 준다(IDF):
 *   1건에만 나오는 '삼겹살' = 아주 강함, 25건에 나오는 '고무스카시20T' = 약함, 거의 다 나오면 ≈ 0.
 * 점수 = 맞은 단서들의 무게 합 → 높은 순. 이지폼을 다시 뒤지지 않고 웹에서 바로 계산한다.
 */
import type { EasyformScannedStatement } from './easyformClient';

/** 비교용 정규화 — 공백 제거·소문자. '숙성 삼겹살' = '숙성삼겹살', 'H:118' = 'h:118'. */
export function normClue(s: string): string {
  return (s || '').replace(/\s+/g, '').toLowerCase();
}

/** 입력 글자 → 단서 목록(쉼표·줄바꿈으로 구분, 중복·빈칸 제거). 숫자 사이 쉼표(규격 'H:69,183')는 안 끊음. */
export function parseClues(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || '').split(/\n|,(?!\d)|(?<!\d),/)) {
    const c = raw.trim();
    if (c && !out.some((o) => normClue(o) === normClue(c))) out.push(c);
  }
  return out;
}

/** 명세서 1건의 비교용 칸들(품목코드·품목·규격·수량·단가·비고, 정규화). */
function cells(s: EasyformScannedStatement): string[] {
  return [...(s.items || []), ...(s.specs || []), ...(s.remarks || []), ...(s.codes || []), ...(s.qtys || []), ...(s.prices || [])]
    .map(normClue)
    .filter(Boolean);
}

/**
 * 단서가 이 명세서에 있나 — 칸 안에 단서가 들어 있거나('삼겹살' ⊂ '숙성삼겹살컷팅'),
 * 3글자 넘는 칸이 단서 안에 들어 있으면('스카시20t' ⊂ '고무스카시20t') 맞은 걸로 본다.
 */
function hasClue(cs: string[], c: string): boolean {
  return cs.some((x) => x.includes(c) || (x.length >= 3 && c.includes(x)));
}

export interface ClueStat {
  clue: string;
  df: number; // 몇 건의 명세서에 나오나
  weight: number; // 0(흔함) ~ 큼(드묾)
}

export interface ClueHit {
  s: EasyformScannedStatement;
  score: number;
  matched: string[]; // 맞은 단서(원래 글자)
}

export function rankByClues(
  scanned: EasyformScannedStatement[],
  clues: string[],
): { stats: ClueStat[]; hits: ClueHit[] } {
  const n = scanned.length;
  const docs = scanned.map(cells);
  const norm = clues.map(normClue).filter(Boolean);
  const stats: ClueStat[] = norm.map((c, k) => {
    const df = docs.filter((cs) => hasClue(cs, c)).length;
    // IDF — 1건이면 크고, 거의 다 나오면 0 근처. 안 나오면 0.
    const weight = df === 0 ? 0 : Math.max(0, Math.log((n + 1) / df));
    return { clue: clues[k], df, weight };
  });
  const hits: ClueHit[] = [];
  scanned.forEach((s, i) => {
    let score = 0;
    const matched: string[] = [];
    norm.forEach((c, k) => {
      if (hasClue(docs[i], c)) {
        score += stats[k].weight;
        matched.push(stats[k].clue);
      }
    });
    if (matched.length) hits.push({ s, score, matched });
  });
  // 점수 높은 순, 같으면 맞은 단서 많은 순, 그다음 최신순(idx 작은 것).
  hits.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.s.idx - b.s.idx);
  return { stats, hits };
}
