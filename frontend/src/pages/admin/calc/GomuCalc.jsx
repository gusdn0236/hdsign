import { useMemo, useState } from 'react'
import { formatPrice, gomuBandForHeight, selectAllOnFocus, buildCopyText } from './helpers'
import CalcAction from './CalcAction'

/**
 * 가격표의 '20,30T' 처럼 한 가격키가 여러 두께를 묶는 경우, 드롭다운에선 20T/30T 로 쪼갠다
 * (가격은 같은 키를 공유). 품목코드는 이지폼 매출에서 가장 많이 쓰인 표기 —
 * 일반=스카시{두께}, 금은색=금색스카시{두께}(금색 고정, 은색이면 사용자가 직접 수정).
 */
function buildGomuOptions(thicknessKeys) {
    const out = []
    for (const key of thicknessKeys || []) {
        const gold = key.includes('금은색')
        const base = key.replace('-금은색', '') // '10T' | '20,30T' | '50T'
        for (const raw of base.split(',').map(s => s.trim()).filter(Boolean)) {
            const t = raw.endsWith('T') ? raw : raw + 'T' // '20' → '20T'
            out.push({
                value: gold ? `${t}-금은색` : t,
                label: gold ? `${t}-금은색` : t,
                priceKey: key, // 가격 조회는 원래 키(20,30T 공유)
                codeT: t, // 코드용 두께(20T/30T 구분)
                gold,
            })
        }
    }
    return out
}

export default function GomuCalc({ prices }) {
    const calc = prices.calculators.gomu
    const options = useMemo(() => buildGomuOptions(calc.axes.thickness), [calc.axes.thickness])
    const [val, setVal] = useState(options[0]?.value || '')
    const [height, setHeight] = useState('100')
    const [qty, setQty] = useState('1')

    const opt = options.find(o => o.value === val) || options[0]
    const heightMm = parseInt(height, 10)
    const qtyN = parseInt(qty, 10)
    const band = Number.isFinite(heightMm) && heightMm > 0 ? gomuBandForHeight(heightMm) : null
    const unitPrice = band && opt ? calc.prices?.[opt.priceKey]?.[band] ?? null : null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null
    const code = opt ? (opt.gold ? `금색스카시${opt.codeT}` : `스카시${opt.codeT}`) : ''

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>두께·종류</span>
                    <select value={val} onChange={e => setVal(e.target.value)}>
                        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <input
                        type="number" min="1" max="2000" value={height}
                        onChange={e => setHeight(e.target.value)}
                        onFocus={() => setHeight('')}
                    />
                </label>

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        type="number" min="1" value={qty}
                        onChange={e => setQty(e.target.value)}
                        onFocus={() => setQty('')}
                    />
                </label>
            </div>

            <div className="calc-result">
                <CalcAction
                    copyText={buildCopyText(unitPrice, qtyN, '개', total)}
                    payload={{ code, spec: heightMm ? String(heightMm) : '', qty: qtyN, unit: unitPrice }}
                />
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null && total !== null
                        ? `${code} ${heightMm}mm — ${formatPrice(unitPrice)} × ${qtyN}개`
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
