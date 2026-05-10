import { useState } from 'react'
import { formatPrice, selectAllOnFocus } from './helpers'

export default function EpoxyCalc({ prices }) {
    const calc = prices.calculators.epoxy
    const { material, textType, sizes, strokes } = calc.axes
    const [matKey, setMatKey] = useState(material[0].key)
    const [ttKey, setTtKey] = useState(textType[0].key)
    const [size, setSize] = useState(sizes[0])
    const [strokeVal, setStrokeVal] = useState(strokes[0].value)
    const [qty, setQty] = useState('1')

    const qtyN = parseInt(qty, 10)
    const sizeMap = calc.prices?.[matKey]?.[ttKey]?.[String(size)]
    const unitPrice = sizeMap?.[String(strokeVal)] ?? null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null

    const matLabel = material.find(m => m.key === matKey)?.label
    const ttLabel  = textType.find(t => t.key === ttKey)?.label
    const strokeLabel = strokes.find(s => s.value === strokeVal)?.label

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>재질</span>
                    <select value={matKey} onChange={e => setMatKey(e.target.value)}>
                        {material.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>종류</span>
                    <select value={ttKey} onChange={e => setTtKey(e.target.value)}>
                        {textType.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <select value={size} onChange={e => setSize(Number(e.target.value))}>
                        {sizes.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>획 두께</span>
                    <select value={strokeVal} onChange={e => setStrokeVal(Number(e.target.value))}>
                        {strokes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        type="number" min="1" value={qty}
                        onChange={e => setQty(e.target.value)}
                        onFocus={selectAllOnFocus}
                    />
                </label>
            </div>

            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null && total !== null
                        ? `${matLabel} 에폭시 ${size}mm ${ttLabel} ${strokeLabel} (${formatPrice(unitPrice)}) × ${qtyN}개`
                        : (unitPrice !== null
                            ? '수량을 입력하세요'
                            : '해당 조합에 등록된 단가가 없습니다')}
                </div>
            </div>
        </div>
    )
}
