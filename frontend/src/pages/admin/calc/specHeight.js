/**
 * 계산기 높이칸 텍스트(명세서 규격 표기 그대로)에서 계산용 높이(mm)를 뽑는다.
 *   'h:88' / 'H88'      → 88
 *   '100*120' / '100x120' → 120 (가로*세로 표기 — 세로=높이, engine/normalize.parseSpec 과 같은 규칙)
 *   '88'                → 88
 * 못 뽑으면 NaN. 텍스트 자체는 그대로 명세서 규격칸에 들어간다.
 */
export function specHeight(text) {
  const s = String(text || '').trim()
  if (!s) return NaN
  const h = s.match(/h\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  if (h) return Math.round(parseFloat(h[1]))
  const wh = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i)
  if (wh) return Math.round(parseFloat(wh[2]))
  const n = s.match(/\d+(?:\.\d+)?/)
  return n ? Math.round(parseFloat(n[0])) : NaN
}
