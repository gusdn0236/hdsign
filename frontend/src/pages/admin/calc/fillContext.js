import { createContext } from 'react'

/**
 * 계산기 카드의 결과 버튼을 '복사' 대신 '명세서 행에 채우기'로 바꾸기 위한 컨텍스트.
 *
 * - null(기본): /admin/calc 같은 일반 사용 → 카드는 [복사] 버튼.
 * - 값 제공(명세서작성 미니 계산기): { onFill, label, canFill } → 카드는 [N번에 채우기] 버튼.
 *
 * onFill(payload) payload = { code, spec, qty, unit } — 명세서 행의 품목코드/규격/수량/단가에 채운다.
 */
export const FillContext = createContext(null)
