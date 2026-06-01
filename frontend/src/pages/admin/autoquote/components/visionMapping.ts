/**
 * 비전 RICH 스키마 → 견적엔진 LineInput[] 매핑 (순수 함수, DOM/네트워크 없음).
 *
 * 계약(decomposition §slice-2): line i = {
 *   category: sign_types[i], w: dimensions[i].w, h: dimensions[i].h,
 *   coats: dimensions[i].coats, qty: qty[i] ?? 1, brandText: brand_text }.
 * 라인 수는 sign_types 길이가 기준. brand_text 는 전 항목 공통 식별필터(가격예측 아님).
 */
import type { LineInput } from '../engine';
import type { VisionItems } from './visionClient';

export function visionToLineInputs(v: VisionItems): LineInput[] {
  const types = v.sign_types ?? [];
  return types.map((category, i) => {
    const d = v.dimensions?.[i] ?? {};
    return {
      category,
      w: d.w,
      h: d.h,
      coats: d.coats,
      qty: v.qty?.[i] ?? 1,
      brandText: v.brand_text?.trim() || undefined,
    };
  });
}
