import CalcLayout from './calc/CalcLayout.jsx'
import PricesAdmin from './PricesAdmin.jsx'

/**
 * 단가 계산기 + 단가표 관리(엑셀 업로드)를 한 페이지에 통합.
 *
 * 위쪽: 7개 계산기 (백엔드 없이 동작 — 빌드 번들에 prices.json 포함)
 * 아래쪽: 단가표 업로드/리뷰 (관리자 토큰 + Railway 백엔드 필요 — 가끔 단가 갱신 시만)
 *
 * 분리 이유: 두 영역은 사용 빈도/의존성이 다르지만 한 화면에 같이 놓아야
 * "이 단가표가 어떻게 반영되는지" 직관적으로 보임.
 */
export default function PricesPage() {
    return (
        <>
            <CalcLayout />
            <hr className="page-divider" />
            <PricesAdmin />
        </>
    )
}
