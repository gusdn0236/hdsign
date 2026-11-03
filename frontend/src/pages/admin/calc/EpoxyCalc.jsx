import { useState } from 'react'
import { formatPrice, selectAllOnFocus, buildCopyText } from './helpers'
import CalcAction from './CalcAction'
import FillTextSlot from './FillTextSlot'
import { enterToFillText, enterToNextInput, specHeight, bandUp } from './specHeight'

export default function EpoxyCalc({ prices }) {
    const calc = prices.calculators.epoxy
    const { material, textType, sizes, strokes } = calc.axes
    const [matKey, setMatKey] = useState(material[0].key)
    const [ttKey, setTtKey] = useState(textType[0].key)
    // 높이·규격은 텍스트(h:88 · 100*120 그대로 규격칸에). 단가는 표 사이즈 중 그 높이 이상 가장 작은 것.
    const [sizeText, setSizeText] = useState(String(sizes[0]))
    const heightMm = specHeight(sizeText)
    const size = bandUp(sizes, heightMm)
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
                    <span>높이·규격</span>
                    <input
                        type="text" value={sizeText}
                        onChange={e => setSizeText(e.target.value)}
                        onKeyDown={enterToNextInput}
                    />
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
                        onKeyDown={enterToFillText}
                        onChange={e => setQty(e.target.value)}
                        onFocus={() => setQty('')}
                    />
                </label>
            </div>

            <FillTextSlot />
            <div className="calc-result">
                <CalcAction
                    copyText={buildCopyText(unitPrice, qtyN, '개', total)}
                    payload={{ code: `${matLabel || ''}에폭시`, spec: sizeText.trim(), qty: qtyN, unit: unitPrice }}
                />
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null && total !== null
                        ? `${matLabel} 에폭시 ${size}mm${size !== heightMm ? ` (${heightMm}mm→${size}mm 단가)` : ''} ${ttLabel} ${strokeLabel} (${formatPrice(unitPrice)}) × ${qtyN}개`
                        : (unitPrice !== null
                            ? '수량을 입력하세요'
                            : '해당 조합에 등록된 단가가 없습니다')}
                </div>
            </div>
        </div>
    )
}
