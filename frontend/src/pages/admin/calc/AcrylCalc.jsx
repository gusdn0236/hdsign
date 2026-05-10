import { useState } from 'react'
import { formatPrice, acrylBandForHeight } from './helpers'

export default function AcrylCalc({ prices }) {
    const calc = prices.calculators.acryl
    const { thickness, textType } = calc.axes
    const [tk, setTk] = useState(thickness[0])
    const [tt, setTt] = useState(textType[0])
    const [height, setHeight] = useState(100)
    const [qty, setQty] = useState(1)

    const band = height > 0 ? acrylBandForHeight(height) : null
    const unitPrice = band ? calc.prices?.[tk]?.[tt]?.[band] ?? null : null
    const total = unitPrice !== null ? unitPrice * qty : null

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>두께</span>
                    <select value={tk} onChange={e => setTk(e.target.value)}>
                        {thickness.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>종류</span>
                    <select value={tt} onChange={e => setTt(e.target.value)}>
                        {textType.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <input
                        type="number" min="1" max="900" value={height}
                        onChange={e => setHeight(Math.max(1, Number(e.target.value) || 1))}
                    />
                </label>

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        type="number" min="1" value={qty}
                        onChange={e => setQty(Math.max(1, Number(e.target.value) || 1))}
                    />
                </label>
            </div>

            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null
                        ? `아크릴 ${tt} ${tk} ${height}mm 밴드(${band}) — ${formatPrice(unitPrice)} × ${qty}개`
                        : (height > 900
                            ? '900mm 까지만 등록되어 있습니다'
                            : '해당 조합에 등록된 단가가 없습니다')}
                </div>
            </div>
        </div>
    )
}
