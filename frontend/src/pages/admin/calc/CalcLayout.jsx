import { usePrices } from './usePrices'
import ChannelCalc    from './ChannelCalc.jsx'
import LedCalc        from './LedCalc.jsx'
import FrameCalc      from './FrameCalc.jsx'
import EpoxyCalc      from './EpoxyCalc.jsx'
import AcrylCalc      from './AcrylCalc.jsx'
import GomuCalc       from './GomuCalc.jsx'
import GoldSilverCalc from './GoldSilverCalc.jsx'
import './Calc.css'

/**
 * 계산기 7개를 한 페이지에 전부 쌓아 보여줌. 원본 ChannelCalc 사이트와 동일한 흐름.
 *
 *   1) 잔넬 단가 (큰 카드, 가장 자주 씀)
 *   2) LED 추가 + 후렘 추가 (가로 2열 — 잔넬 결과를 옆에서 보면서 쓸 수 있게)
 *   3) 에폭시 / 아크릴·포맥스 / 고무스카시 / 금은경 (순서대로 스택)
 */
export default function CalcLayout() {
    const { prices } = usePrices()
    if (!prices) return <div className="calc-shell"><p>로드 중...</p></div>

    return (
        <div className="calc-shell">
            <ChannelCalc prices={prices} />

            <div className="calc-row">
                <LedCalc prices={prices} />
                <FrameCalc prices={prices} />
            </div>

            <EpoxyCalc      prices={prices} />
            <AcrylCalc      prices={prices} />
            <GomuCalc       prices={prices} />
            <GoldSilverCalc prices={prices} />
        </div>
    )
}
