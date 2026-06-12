import { useState, useMemo } from 'react'
import { formatPrice, channelSizes, selectAllOnFocus, buildCopyText } from './helpers'
import CalcAction from './CalcAction'

export default function ChannelCalc({ prices }) {
    const calc = prices.calculators.channel
    const sizes = useMemo(() => channelSizes(calc.sizeAxis), [calc.sizeAxis])
    const [typeKey, setTypeKey] = useState(calc.types[0]?.key || '')
    const [size, setSize] = useState(sizes[0] || 200)
    const [lang, setLang] = useState('eng')
    const [qty, setQty] = useState('1')

    const qtyN = parseInt(qty, 10)
    const type = calc.types.find(t => t.key === typeKey)
    const unitPrice = type?.needsLang
        ? type?.pricesByLang?.[lang]?.[String(size)] ?? null
        : type?.prices?.[String(size)] ?? null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>종류</span>
                    <select value={typeKey} onChange={e => setTypeKey(e.target.value)}>
                        {calc.types.map(t => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                    </select>
                </label>

                <label className="calc-field">
                    <span>규격 (mm)</span>
                    <select value={size} onChange={e => setSize(Number(e.target.value))}>
                        {sizes.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>

                {type?.needsLang && (
                    <div className="calc-field">
                        <span>한 / 영</span>
                        <div className="seg">
                            <button
                                type="button"
                                className={`seg-btn ${lang === 'eng' ? 'active' : ''}`}
                                onClick={() => setLang('eng')}
                            >영문/숫자</button>
                            <button
                                type="button"
                                className={`seg-btn ${lang === 'kor' ? 'active' : ''}`}
                                onClick={() => setLang('kor')}
                            >한글</button>
                        </div>
                    </div>
                )}

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        type="number" min="1" value={qty}
                        onChange={e => setQty(e.target.value)}
                        onFocus={() => setQty('')}
                    />
                </label>
            </div>

            <ResultBox
                primary={total}
                copyText={buildCopyText(unitPrice, qtyN, '개', total)}
                payload={{ code: '잔넬', spec: size ? String(size) : '', qty: qtyN, unit: unitPrice }}
                breakdown={
                    unitPrice !== null && total !== null
                        ? `${type.label} ${size}mm (${formatPrice(unitPrice)}) × ${qtyN}개`
                        : (unitPrice !== null
                            ? '수량을 입력하세요'
                            : '해당 사이즈에 가격이 등록되어 있지 않습니다')
                }
            />
        </div>
    )
}

function ResultBox({ primary, breakdown, copyText, payload }) {
    return (
        <div className="calc-result">
            <CalcAction copyText={copyText} payload={payload} />
            <div className="calc-result-num">{formatPrice(primary)}</div>
            <div className="calc-result-sub">{breakdown}</div>
        </div>
    )
}
