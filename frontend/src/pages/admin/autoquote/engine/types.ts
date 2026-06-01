/**
 * Pure-TS quote engine types (ported from tenet-test/web engine, adapted to the
 * hdsign auto-quote `estimate(line, ctx)` contract). No DOM, no network — every
 * symbol here is plain data so the engine stays deterministic and unit-testable.
 *
 * Sources: .tenet/spec/2026-06-01-auto-quote.md §"Interface contracts",
 * .tenet/knowledge/2026-05-30_pricing-normalization.md,
 * .tenet/knowledge/2026-05-31_domain-n-do-paint-means-n-coats.md.
 */

export type Confidence = 'high' | 'mid' | 'low';

/**
 * Where a produced price came from (spec §"Interface contracts"). Every
 * non-discount line carries at least one of these.
 *  - `history`     — matched a past invoice line (tier ①, ground truth)
 *  - `size`        — size curve within a brand cohort (tier ②) or category (tier ③)
 *  - `category`    — category flat-median fallback (tier ③, weakest)
 *  - `correction`  — a staff correction overrode the match (top prior)
 */
export interface EvidenceRef {
  type: 'history' | 'size' | 'category' | 'correction';
  /** Invoice id the price was read from (history/correction). */
  invoiceId?: string;
  /** Line index within the source invoice/corpus. */
  line?: number;
  /** Hierarchy tier label: '①' | '②' | '③' (and 'correction'). */
  tier?: string;
  /** Human-readable reason ("왜 이 가격"). */
  note?: string;
}

/** A single manual-entry line from the 자동견적 tab. */
export interface LineInput {
  category: string;
  /** Width in millimetres. */
  w?: number;
  /** Height in millimetres. */
  h?: number;
  /** Paint coats (N도). 1..7 plausible; 90/45 is a bend angle, not coats. */
  coats?: number;
  qty: number;
  /**
   * Brand text read off the work order. This is an IDENTITY FILTER, never a
   * price predictor (easyform Level-B finding): it narrows which past invoices
   * are "the same item", but the number always comes from history or size.
   */
  brandText?: string;
}

/**
 * A reference line from the confidential corpus (served by the JWT backend at
 * GET /api/admin/autoquote/corpus). `source` distinguishes hand-written invoice
 * ground truth from a derived price-table row; on conflict we pull toward the
 * invoice (knowledge §"unit_price … 정답으로 신뢰").
 */
export interface CorpusItem {
  /** Invoice id used in evidence (`history`). */
  id?: string;
  /** Index in the corpus array; used as evidence `line` when no id. */
  index?: number;
  client?: string;
  date?: string;
  category: string;
  /** Item text (품목명). */
  name: string;
  /** Brand text, if the corpus row carries one (identity only). */
  brand?: string;
  spec?: string;
  /** mm. */
  width?: number;
  /** mm. */
  height?: number;
  qty?: number;
  /** Integer won. */
  unitPrice: number;
  /** Invoice ground truth vs derived price-table row. Default 'invoice'. */
  source?: 'invoice' | 'price-table';
}

/** A staff correction (top prior). Absent in slice 1, optional in the contract. */
export interface Correction {
  id: string;
  /** `${category}::${sizeBucket}` style key, or a free item name. */
  featureKey?: string;
  category?: string;
  name?: string;
  brand?: string;
  spec?: string;
  width?: number;
  height?: number;
  correctedUnitPrice: number;
  explanation?: string;
  author?: string;
  date?: string;
}

/** Learned static priors served by GET /api/admin/autoquote/priors. */
export interface Priors {
  bridges?: unknown;
  reorderPairs?: unknown;
  /** category -> ordered size buckets (size→price). */
  sizeBuckets?: Record<string, Array<{ maxHeight: number; unitPrice: number }>>;
  synthDigest?: unknown;
}

/** Context passed to {@link estimate}. `corrections` is optional (slice 1: absent). */
export interface EstimateContext {
  corpus: CorpusItem[];
  priors?: Priors;
  corrections?: Correction[];
}

/** Result of {@link estimate} — the contract return shape (plus UI flags). */
export interface EstimateResult {
  /** Integer won, per piece. */
  unitPrice: number;
  /** Line subtotal = unitPrice × qty (pre-VAT; quote VAT is in totals). */
  total: number;
  confidence: Confidence;
  /** ≥1 ref for every non-discount line. */
  evidence: EvidenceRef[];
  /** True when confidence is `low` — UI surfaces a low-confidence flag. */
  lowConfidence: boolean;
  /** Set when the coats value looked implausible (bend angle / typo). */
  coatWarning?: string;
}

/** Parsed size spec. All dimensions in millimetres; area is mm². */
export interface SpecParse {
  width?: number;
  height?: number;
  area?: number;
}
