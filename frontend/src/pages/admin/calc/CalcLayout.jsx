import { usePrices } from './usePrices'
import ChannelCalc    from './ChannelCalc.jsx'
import LedCalc        from './LedCalc.jsx'
import FrameCalc      from './FrameCalc.jsx'
import EpoxyCalc      from './EpoxyCalc.jsx'
import AcrylCalc      from './AcrylCalc.jsx'
import GomuCalc       from './GomuCalc.jsx'
import GoldSilverCalc from './GoldSilverCalc.jsx'
import QuickUpload    from './QuickUpload.jsx'
import PriceLookup     from './PriceLookup.tsx'
import './Calc.css'

/**
 * 단가 페이지 — 좌측에 계산기 7개, 우측에 단가표 업로드 사이드바.
 *
 * 사용 빈도 순으로 위→아래 정렬: 아크릴(가장 많이 씀) → 잔넬 → LED+후렘 → 에폭시 → 고무 → 금은경.
 * 우측 사이드바는 sticky 라 스크롤해도 따라옴.
 * 좁은 화면(< 1080px)에선 사이드바가 위로 올라가 세로 스택.
 */
export default function CalcLayout() {
    const { prices } = usePrices()
    if (!prices) return <div className="calc-shell"><p>로드 중...</p></div>

    return (
        <div className="calc-shell">
            <main className="calc-main">
                <PriceLookup />

                <AcrylCalc prices={prices} />
                <ChannelCalc prices={prices} />

                <div className="calc-row">
                    <LedCalc prices={prices} />
                    <FrameCalc prices={prices} />
                </div>

                <EpoxyCalc      prices={prices} />
                <GomuCalc       prices={prices} />
                <GoldSilverCalc prices={prices} />
            </main>

            <QuickUpload />
        </div>
    )
}
