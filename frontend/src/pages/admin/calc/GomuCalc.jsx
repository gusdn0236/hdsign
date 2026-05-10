import { useState } from 'react'
import { formatPrice, gomuBandForHeight } from './helpers'

export default function GomuCalc({ prices }) {
    const calc = prices.calculators.gomu
    const thicknesses = calc.axes.thickness
    const [tk, setTk] = useState(thicknesses[0])
    const [height, setHeight] = useState('100')
    const [qty, setQty] = useState('1')

    const heightMm = parseInt(height, 10)
    const qtyN = parseInt(qty, 10)
    const band = Number.isFinite(heightMm) && heightMm > 0 ? gomuBandForHeight(heightMm) : null
    const unitPrice = band ? calc.prices?.[tk]?.[band] ?? null : null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>두께·종류</span>
                    <select value={tk} onChange={e => setTk(e.target.value)}>
                        {thicknesses.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <input
                        type="number" min="1" max="2000" value={height}
                        onChange={e => setHeight(e.target.value)}
                    />
                </label>

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        type="number" min="1" value={qty}
                        onChange={e => setQty(e.target.value)}
                    />
                </label>
            </div>

            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null && total !== null
                        ? `고무 ${tk} ${heightMm}mm 밴드(${band}) — ${formatPrice(unitPrice)} × ${qtyN}개`
                        : (heightMm > 2000
                            ? '2000mm 까지만 등록되어 있습니다'
                            : (Number.isFinite(heightMm) && heightMm > 0
                                ? '해당 조합에 등록된 단가가 없습니다'
                                : '높이/수량을 입력하세요'))}
                </div>
            </div>
        </div>
    )
}
