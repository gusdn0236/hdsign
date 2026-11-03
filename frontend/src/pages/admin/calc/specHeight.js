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

/** 높이·규격칸 Enter → 같은 폼의 다음 입력칸(수량)으로 포커스 이동. 한글 조합 중 Enter 는 무시. */
export function enterToNextInput(e) {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
  e.preventDefault()
  const form = e.currentTarget.closest('.calc-form')
  if (!form) return
  const ins = [...form.querySelectorAll('input')]
  const next = ins[ins.indexOf(e.currentTarget) + 1]
  if (next) next.focus()
}

/** 수량칸 Enter → 같은 카드의 품목(텍스트) 입력칸으로 포커스(미니계산기에서만 존재, 없으면 무시). */
export function enterToFillText(e) {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
  const card = e.currentTarget.closest('.calc-card')
  const t = card && card.querySelector('.minicalc-text input')
  if (!t) return
  e.preventDefault()
  t.focus()
  t.select()
}

/** 단가표 사이즈 목록에서 높이 h 이상인 가장 작은 사이즈(표에 없는 높이는 한 단계 위 단가). 넘치면 null. */
export function bandUp(sizes, h) {
  if (!Number.isFinite(h) || h <= 0) return null
  const s = [...sizes].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  return s.find(x => x >= h) ?? null
}
