import type { CorpusItem, SpecParse } from './types';
import { normalize, normalizeBrand, parseSpec, dimsFrom } from './normalize';

/**
 * Pure, dependency-free similarity search over corpus invoice lines.
 *
 * The tenet-test/web reference used fuse.js; this port keeps the same scoring
 * shape (`final = 0.7·text + 0.3·numeric`) with a self-contained character-bigram
 * Dice coefficient so the engine has NO runtime dependency and stays
 * deterministic. Brand text is applied as an IDENTITY FILTER before scoring — it
 * narrows candidates to "the same shop's item", it never feeds the score or price
 * (easyform Level-B: brand_text alone predicts worse than size-only).
 */

export const TEXT_WEIGHT = 0.7;
export const NUMERIC_WEIGHT = 0.3;
/** Minimum text score for a candidate to be considered a match at all. */
export const TEXT_FLOOR = 0.34;

export interface SearchQuery {
  name: string;
  spec?: string;
  width?: number;
  height?: number;
  /** Identity filter only (knowledge / Level-B). Never scored. */
  brandText?: string;
}

export interface Match {
  /** Index into the corpus array. */
  index: number;
  /** Stable invoice id for evidence, when present. */
  id?: string;
  name: string;
  category?: string;
  brand?: string;
  unitPrice: number;
  width?: number;
  height?: number;
  date?: string;
  client?: string;
  /** 'invoice' ground truth outranks a derived 'price-table' row. */
  source: 'invoice' | 'price-table';
  /** 0..1, 1 = perfect text match. */
  textScore: number;
  /** 0..1, 1 = identical size. */
  numericScore: number;
  /** Relative area delta vs query (Infinity when not comparable). */
  sizeDeltaPct: number;
  /** 0.7·text + 0.3·numeric. */
  finalScore: number;
}

/** Character bigrams of a normalized string. */
function bigrams(s: string): string[] {
  const clean = s.replace(/\s+/g, '');
  if (clean.length < 2) return clean ? [clean] : [];
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

/**
 * Sørensen–Dice coefficient over character bigrams (0..1). Order-independent and
 * robust to small edits — a good drop-in for fuzzy name matching without a lib.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      counts.set(g, c - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (ba.length + bb.length);
}

function numericScore(
  q: SpecParse,
  cWidth?: number,
  cHeight?: number,
): { score: number; deltaPct: number } {
  const qArea = q.area;
  const cArea = cWidth != null && cHeight != null ? cWidth * cHeight : undefined;
  if (qArea == null || cArea == null || qArea === 0) {
    // Not comparable: neutral, never "size-close".
    return { score: 0.5, deltaPct: Infinity };
  }
  const deltaPct = Math.abs(cArea - qArea) / qArea;
  return { score: Math.max(0, 1 - deltaPct), deltaPct };
}

/**
 * True when `brandText` and a candidate brand/name refer to the same identity.
 * Used to FILTER candidates, not to score them.
 */
export function brandMatches(brandText: string, item: CorpusItem): boolean {
  const b = normalizeBrand(brandText);
  if (!b) return true; // no brand to filter on → keep everything
  const cand = normalizeBrand(item.brand) || normalize(item.name);
  if (!cand) return false;
  return cand.includes(b) || b.includes(cand);
}

/**
 * Rank corpus lines against a query: `final = 0.7·text + 0.3·numeric`. When a
 * `brandText` is given, candidates are first filtered to the same brand identity
 * (no score contribution). Ties break toward invoice ground truth over a
 * price-table row, then toward the more recent record.
 */
export function similaritySearch(
  query: SearchQuery,
  corpus: CorpusItem[],
): Match[] {
  const qNorm = normalize(query.name);

  const qSpec = parseSpec(query.spec);
  if (query.width != null) qSpec.width = query.width;
  if (query.height != null) qSpec.height = query.height;
  if (qSpec.width != null && qSpec.height != null) {
    qSpec.area = qSpec.width * qSpec.height;
  }

  const brand = query.brandText ?? '';

  const matches: Match[] = [];
  corpus.forEach((it, index) => {
    if (brand && !brandMatches(brand, it)) return; // identity filter
    const dims = it.width != null || it.height != null
      ? dimsFrom(it.width, it.height)
      : parseSpec(it.spec);
    const textScore = qNorm ? diceCoefficient(qNorm, normalize(it.name)) : 0;
    if (qNorm && textScore < TEXT_FLOOR) return;
    const { score: numScore, deltaPct } = numericScore(
      qSpec,
      dims.width,
      dims.height,
    );
    matches.push({
      index,
      id: it.id,
      name: it.name,
      category: it.category,
      brand: it.brand,
      unitPrice: it.unitPrice,
      width: dims.width,
      height: dims.height,
      date: it.date,
      client: it.client,
      source: it.source ?? 'invoice',
      textScore,
      numericScore: numScore,
      sizeDeltaPct: deltaPct,
      finalScore: TEXT_WEIGHT * textScore + NUMERIC_WEIGHT * numScore,
    });
  });

  matches.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    // price-table vs invoice conflict → pull toward invoice ground truth.
    if (a.source !== b.source) return a.source === 'invoice' ? -1 : 1;
    return (b.date ?? '').localeCompare(a.date ?? '');
  });
  return matches;
}
