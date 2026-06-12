import { useContext } from 'react'
import CopyButton from './CopyButton'
import { FillContext } from './fillContext'

/**
 * 계산기 결과 액션 버튼 — 상황에 따라 [복사] 또는 [N번에 채우기].
 *
 * 명세서작성 미니 계산기(FillContext 제공) 에서는 계산된 단가가 있으면 '채우기' 버튼을 띄워,
 * 누르면 명세서의 빈 행에 품목코드/규격/수량/단가를 채운다(품목은 비워둠). 그 외(일반 단가
 * 페이지)에서는 기존 [복사] 버튼 그대로.
 */
export default function CalcAction({ copyText, payload }) {
  const fill = useContext(FillContext)
  if (fill && payload && payload.unit != null) {
    return (
      <button
        type="button"
        className="calc-fillbtn"
        disabled={!fill.canFill}
        onClick={() => fill.onFill(payload)}
        title="계산된 값을 명세서의 이 행에 채웁니다 (품목은 직접 입력)"
      >
        {fill.num != null && (
          <span className="calc-fillbtn-num" style={{ background: fill.color }}>{fill.num}</span>
        )}
        번에 채우기
      </button>
    )
  }
  return <CopyButton text={copyText} />
}
