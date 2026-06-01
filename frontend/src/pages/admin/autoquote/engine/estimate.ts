import type {
  Correction,
  EstimateContext,
  EstimateResult,
  EvidenceRef,
  LineInput,
} from './types';
import { dimsFrom, interpretCoats } from './normalize';
import {
  breakdownEstimate,
  paintingSurcharge,
  resolveCategory,
} from './pricing';
import { brandMatches, similaritySearch } from './similarity';
import { isLowConfidence, scoreConfidence } from './confidence';

/**
 * The auto-quote engine entry point — the `estimate(line, ctx)` contract from
 * .tenet/decomposition/2026-06-01-auto-quote.md §"Interface contracts".
 *
 * Implements the confirmed pricing hierarchy:
 *   ① history (a matched past invoice line — ground truth)
 *      > ② brand-as-identity-filter + size curve
 *      > ③ category + size curve.
 * A staff correction, when present, is the top prior above all tiers.
 *
 * Key domain rules enforced here:
 *  - **brand_text is an IDENTITY FILTER, not a price predictor**: it only narrows
 *    which corpus lines count as "the same item"; the number always comes from
 *    history or the size curve (easyform Level-B finding).
 *  - **price-table vs invoice conflict pulls toward the invoice** (handled by the
 *    similarity sort, which ranks invoice ground truth above price-table rows).
 *  - **N도 = N paint coats** (1..7): a bend angle (90/45) or implausible value is
 *    NOT priced as paint; it surfaces a `coatWarning` instead.
 *  - **every non-discount result carries ≥1 evidence ref**.
 */

/** Minimum similarity score for a corpus match to count as tier-① history. */
export const HISTORY_MIN_SCORE = 0.45;

function findCorrection(
  line: LineInput,
  canon: string | undefined,
  corrections: Correction[],
): Correction | undefined {
  const brand = line.brandText ?? '';
  const candidates = corrections.filter((c) => {
    const cCanon =
      resolveCategory(c.category) ??
      (c.featureKey ? resolveCategory(c.featureKey.split('::')[0]) : undefined);
    if (canon && cCanon && cCanon !== canon) return false;
    if (canon && !cCanon && !c.featureKey?.includes(canon)) return false;
    // brand is an identity filter here too.
    if (brand && (c.brand || c.name)) {
      const ok = brandMatches(brand, {
        category: c.category ?? '',
        name: c.name ?? '',
        brand: c.brand,
        unitPrice: c.correctedUnitPrice,
      });
      if (!ok) return false;
    }
    return true;
  });
  // When several corrections match one line, pick the strongest prior
  // deterministically: highest priority first (a boss/shared override outweighs
  // a peer note), tie-broken by the most-recent date. `??`-defaulting keeps the
  // sort total even when priority/date are absent.
  candidates.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa; // priority desc
    return (b.date ?? '').localeCompare(a.date ?? ''); // date desc (newer wins)
  });
  return candidates[0];
}

export function estimate(
  line: LineInput,
  ctx: EstimateContext,
): EstimateResult {
  const qty = line.qty && line.qty > 0 ? line.qty : 1;
  const dims = dimsFrom(line.w, line.h);
  const canon = resolveCategory(line.category);
  const unknownCategory = canon === undefined;
  const coat = interpretCoats(line.coats);

  let basePrice = 0;
  let tier: '①' | '②' | '③' | 'correction' = '③';
  let baseEvidence: EvidenceRef;
  let matchCount = 0;
  let minSizeDelta = Infinity;
  let parametric = false;

  const correction = ctx.corrections?.length
    ? findCorrection(line, canon, ctx.corrections)
    : undefined;

  if (correction) {
    // Top prior: a staff correction overrides every other tier.
    basePrice = correction.correctedUnitPrice;
    tier = 'correction';
    baseEvidence = {
      type: 'correction',
      invoiceId: correction.id,
      tier: 'correction',
      // Cite the author and flag this as a shared/boss override so the UI can
      // explain why it outranks past invoices; append the explanation if given.
      note: `공유 수정단가(상급자 우선) 적용 · 작성자 ${
        correction.author ?? '직원'
      }${correction.explanation ? ` · ${correction.explanation}` : ''}`,
    };
  } else {
    // Tier ①: history. brandText is applied as an identity filter inside search.
    const matches = similaritySearch(
      {
        name: canon ?? line.category,
        width: line.w,
        height: line.h,
        brandText: line.brandText,
      },
      ctx.corpus ?? [],
    ).filter((m) => resolveCategory(m.category) === canon || !canon);
    matchCount = matches.length;
    const best = matches[0];

    if (best && best.finalScore >= HISTORY_MIN_SCORE) {
      basePrice = best.unitPrice;
      tier = '①';
      minSizeDelta = best.sizeDeltaPct;
      parametric = dims.height != null;
      baseEvidence = {
        type: 'history',
        invoiceId: best.id ?? `corpus#${best.index}`,
        line: best.index,
        tier: '①',
        note: `과거 명세서 단가${
          best.source === 'price-table' ? '(단가표)' : ''
        } ₩${basePrice.toLocaleString()} 적용${
          line.brandText ? ` · 브랜드 "${line.brandText}" 동일 식별` : ''
        }`,
      };
    } else {
      // Tier ② (brand cohort, size curve) or ③ (category, size curve).
      const bd = breakdownEstimate(canon ?? line.category, dims);
      if (bd) {
        basePrice = bd.unitPrice;
        parametric = bd.parametric;
        tier = line.brandText ? '②' : '③';
        baseEvidence = {
          type: bd.parametric ? 'size' : 'category',
          tier,
          note: bd.parametric
            ? `${bd.category} 사이즈 곡선 (높이 ${bd.heightCm}cm) 추정${
                line.brandText
                  ? ` · 브랜드 "${line.brandText}"는 식별용(가격 미반영)`
                  : ''
              }`
            : `${bd.category} 대표 단가(중앙값) 추정`,
        };
      } else {
        // Unknown category: cannot price — surface as low confidence.
        basePrice = 0;
        tier = '③';
        baseEvidence = {
          type: 'category',
          tier: '③',
          note: `카테고리 "${line.category}"를 인식하지 못해 단가를 추정할 수 없습니다.`,
        };
      }
    }
  }

  const evidence: EvidenceRef[] = [baseEvidence];
  let unitPrice = basePrice;

  // Paint surcharge — only for a plausible coat count (N도 = N coats).
  if (coat.coats != null) {
    const paint = paintingSurcharge({ coats: coat.coats });
    unitPrice += paint;
    evidence.push({
      type: 'category',
      tier: '도장',
      note: `도장 ${coat.coats}도 +₩${paint.toLocaleString()}`,
    });
  }

  const confidence = scoreConfidence({
    tier,
    matchCount,
    minSizeDelta,
    parametric,
    unknownCategory,
  });

  return {
    unitPrice,
    total: unitPrice * qty,
    confidence,
    evidence,
    lowConfidence: isLowConfidence(confidence),
    ...(coat.warning ? { coatWarning: coat.warning } : {}),
  };
}
