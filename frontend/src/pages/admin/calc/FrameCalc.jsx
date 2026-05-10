import { useState } from 'react'
import { formatPrice, selectAllOnFocus } from './helpers'

export default function FrameCalc({ prices }) {
    const frame = prices.calculators.frame
    const [tab, setTab] = useState('alminum')

    return (
        <div className="calc-card">
            <h2 className="calc-title">{frame.label}</h2>

            <nav className="sub-tabs">
                <button type="button" className={`sub-tab ${tab === 'alminum' ? 'active' : ''}`} onClick={() => setTab('alminum')}>알미늄 바</button>
                <button type="button" className={`sub-tab ${tab === 'galba'   ? 'active' : ''}`} onClick={() => setTab('galba')}>갈바 바</button>
                <button type="button" className={`sub-tab ${tab === 'normal'  ? 'active' : ''}`} onClick={() => setTab('normal')}>일반 갈바</button>
            </nav>

            {tab === 'alminum' && <AlminumBar perMeter={frame.alminumBar.pricePerMeter} />}
            {tab === 'galba'   && <GalbaBar byHeight={frame.galbaBar.byHeight} />}
            {tab === 'normal'  && <NormalFrame perSquareMeter={frame.normal.pricePerSquareMeter} />}
        </div>
    )
}

function AlminumBar({ perMeter }) {
    const [length, setLength] = useState('1')
    const lengthN = parseFloat(length)
    const valid = Number.isFinite(lengthN) && lengthN > 0
    const total = valid ? lengthN * perMeter : null
    return (
        <>
            <div className="calc-form">
                <label className="calc-field">
                    <span>길이 (m)</span>
                    <input
                        type="number" min="0" step="0.1" value={length}
                        onChange={e => setLength(e.target.value)}
                        onFocus={selectAllOnFocus}
                    />
                </label>
            </div>
            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {valid
                        ? `알미늄 바 후렘 — ${lengthN}m × ${formatPrice(perMeter)}/M`
                        : '길이를 입력하세요'}
                </div>
            </div>
        </>
    )
}

function GalbaBar({ byHeight }) {
    const heights = Object.keys(byHeight).map(Number).sort((a, b) => a - b)
    const [h, setH] = useState(heights[0])
    const [length, setLength] = useState('1')
    const lengthN = parseFloat(length)
    const valid = Number.isFinite(lengthN) && lengthN > 0
    const perMeter = byHeight[String(h)]
    const total = valid ? lengthN * perMeter : null
    return (
        <>
            <div className="calc-form">
                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <select value={h} onChange={e => setH(Number(e.target.value))}>
                        {heights.map(x => <option key={x} value={x}>{x}mm</option>)}
                    </select>
                </label>
                <label className="calc-field">
                    <span>길이 (m)</span>
                    <input
                        type="number" min="0" step="0.1" value={length}
                        onChange={e => setLength(e.target.value)}
                        onFocus={selectAllOnFocus}
                    />
                </label>
            </div>
            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {valid
                        ? `갈바 바 후렘 — ${h}mm × ${lengthN}m × ${formatPrice(perMeter)}/M`
                        : '길이를 입력하세요'}
                </div>
            </div>
        </>
    )
}

function NormalFrame({ perSquareMeter }) {
    const [w, setW] = useState('1000')
    const [h, setH] = useState('1000')
    const wN = parseInt(w, 10)
    const hN = parseInt(h, 10)
    const valid = Number.isFinite(wN) && wN > 0 && Number.isFinite(hN) && hN > 0
    const total = valid ? Math.round((wN * hN / 1_000_000) * perSquareMeter) : null
    return (
        <>
            <div className="calc-form">
                <label className="calc-field">
                    <span>가로 (mm)</span>
                    <input
                        type="number" min="0" value={w}
                        onChange={e => setW(e.target.value)}
                        onFocus={selectAllOnFocus}
                    />
                </label>
                <label className="calc-field">
                    <span>세로 (mm)</span>
                    <input
                        type="number" min="0" value={h}
                        onChange={e => setH(e.target.value)}
                        onFocus={selectAllOnFocus}
                    />
                </label>
            </div>
            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {valid
                        ? `일반 후렘 (갈바) — ${wN}mm × ${hN}mm × ${formatPrice(perSquareMeter)}/㎡`
                        : '가로/세로를 입력하세요'}
                </div>
            </div>
        </>
    )
}
