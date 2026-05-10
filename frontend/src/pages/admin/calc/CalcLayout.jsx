import { lazy, Suspense } from 'react'
import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { usePrices } from './usePrices'
import { CALC_META } from './helpers'
import './Calc.css'

const ChannelCalc    = lazy(() => import('./ChannelCalc.jsx'))
const LedCalc        = lazy(() => import('./LedCalc.jsx'))
const FrameCalc      = lazy(() => import('./FrameCalc.jsx'))
const EpoxyCalc      = lazy(() => import('./EpoxyCalc.jsx'))
const AcrylCalc      = lazy(() => import('./AcrylCalc.jsx'))
const GomuCalc       = lazy(() => import('./GomuCalc.jsx'))
const GoldSilverCalc = lazy(() => import('./GoldSilverCalc.jsx'))

export default function CalcLayout() {
    const { prices, error } = usePrices()

    if (error) {
        return (
            <div className="calc-shell">
                <p className="calc-error">단가 데이터 로드 실패: {error}</p>
                <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
                    백엔드(8080)와 <code>/api/public/calc-prices</code> 응답 확인. 브라우저 새로고침(Ctrl+Shift+R)으로 캐시·서비스워커 무효화 후 다시 시도해보세요.
                </p>
            </div>
        )
    }
    if (!prices) {
        return <div className="calc-shell"><p>로드 중...</p></div>
    }

    return (
        <div className="calc-shell">
            <nav className="calc-tabs">
                {CALC_META.map(c => (
                    <NavLink
                        key={c.key}
                        to={c.path}
                        className={({ isActive }) => `calc-tab ${isActive ? 'active' : ''}`}
                    >
                        {c.label}
                    </NavLink>
                ))}
            </nav>

            <Suspense fallback={<div className="calc-card"><p>로드 중...</p></div>}>
                <Routes>
                    <Route index element={<Navigate to="channel" replace />} />
                    <Route path="channel"     element={<ChannelCalc    prices={prices} />} />
                    <Route path="led"         element={<LedCalc        prices={prices} />} />
                    <Route path="frame"       element={<FrameCalc      prices={prices} />} />
                    <Route path="epoxy"       element={<EpoxyCalc      prices={prices} />} />
                    <Route path="acryl"       element={<AcrylCalc      prices={prices} />} />
                    <Route path="gomu"        element={<GomuCalc       prices={prices} />} />
                    <Route path="gold-silver" element={<GoldSilverCalc prices={prices} />} />
                </Routes>
            </Suspense>
        </div>
    )
}
