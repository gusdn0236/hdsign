import { useContext } from 'react'
import { FillContext } from './fillContext'

/**
 * 계산기 카드의 가격 박스(.calc-result) 바로 위 자리 — 명세서작성 미니 계산기에서만
 * 품목(텍스트) 입력칸이 여기 그려진다(재질·두께·높이 설정 → 텍스트 → 채우기 순서).
 * 일반 단가계산기 페이지(FillContext=null)에서는 아무것도 안 그린다.
 */
export default function FillTextSlot() {
  const fill = useContext(FillContext)
  return fill?.textInput ?? null
}
