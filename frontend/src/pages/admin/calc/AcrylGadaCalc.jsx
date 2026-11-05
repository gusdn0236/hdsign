import { useContext, useRef, useState } from 'react'
import { formatPrice, acrylBandForHeight, selectAllOnFocus, buildCopyText } from './helpers'
import CalcAction from './CalcAction'
import { FillContext } from './fillContext'

// 아크릴가다 = 아크릴 가공 후 남는 틀.
// 가격 = √(가로×세로) 를 높이로 보고, 그 높이의 아크릴 1글자 단가의 절반.
//   기본     → 영문 1글자 단가 ÷ 2
//   여백많음 → 한글 1글자 단가 ÷ 2 (따낼 여백이 많아 손이 더 감)
const GADA_TYPES = [
    { key: 'basic', label: '기본', textType: '영문' },
    { key: 'margin', label: '여백많음', textType: '한글' },
]

export default function AcrylGadaCalc({ prices }) {
    const calc = prices.calculators.acryl
    const { thickness } = calc.axes
    const [tk, setTk] = useState(thickness[0])
    const [type, setType] = useState(GADA_TYPES[0].key)
    const [size, setSize] = useState('')
    const [qty, setQty] = useState('1')
    const fill = useContext(FillContext)
    const sizeRef = useRef(null)
    const qtyRef = useRef(null)

    const g = GADA_TYPES.find(t => t.key === type) || GADA_TYPES[0]
    // '530*110' / '530 110' / '530x110' 모두 허용 — * · x · × · 공백 으로 가로/세로 구분.
    const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*(?:[*x×]|\s)\s*(\d+(?:\.\d+)?)$/i)
    const wN = m ? parseFloat(m[1]) : NaN
    const hN = m ? parseFloat(m[2]) : NaN
    const qtyN = parseInt(qty, 10)
    const valid = Number.isFinite(wN) && wN > 0 && Number.isFinite(hN) && hN > 0
    const root = valid ? Math.sqrt(wN * hN) : NaN
    const band = valid ? acrylBandForHeight(root) : null
    const full = band ? calc.prices?.[tk]?.[g.textType]?.[band] ?? null : null
    const unitPrice = full !== null ? Math.round(full / 2) : null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null
    const spec = valid ? `${m[1]}*${m[2]}` : ''
    const payload = { code: `아크릴가다${tk}`, spec, qty: qtyN, unit: unitPrice }

    // 사각 박스라 품목 텍스트 입력 없음 — 두께 Enter → 가로*세로 Enter → 수량 Enter = 바로 N번에 채우기.
    // 채운 뒤엔 가로*세로 칸으로 돌아가 다음 사이즈를 바로 받는다(두께·수량·구분은 유지).
    const enterTo = (ref) => (e) => {
        if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
        e.preventDefault()
        ref.current?.focus()
        ref.current?.select?.()
    }
    const onQtyEnter = (e) => {
        if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
        e.preventDefault()
        if (!fill?.canFill || unitPrice === null || total === null) return
        fill.onFill(payload)
        setTimeout(() => { sizeRef.current?.focus(); sizeRef.current?.select() }, 0)
    }

    return (
        <div className="calc-card">
            <h2 className="calc-title">아크릴가다</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>두께</span>
                    <select value={tk} onChange={e => setTk(e.target.value)} onKeyDown={enterTo(sizeRef)}>
                        {thickness.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>가로*세로</span>
                    <input
                        ref={sizeRef} type="text" value={size}
                        onChange={e => setSize(e.target.value)}
                        onFocus={selectAllOnFocus}
                        onKeyDown={enterTo(qtyRef)}
                    />
                </label>

                <label className="calc-field">
                    <span>수량</span>
                    <input
                        ref={qtyRef} type="number" min="1" value={qty}
                        onKeyDown={onQtyEnter}
                        onChange={e => setQty(e.target.value)}
                    />
                </label>

                <label className="calc-field">
                    <span>구분</span>
                    <select value={type} onChange={e => setType(e.target.value)}>
                        {GADA_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                </label>
            </div>

            <div className="calc-result">
                <CalcAction
                    copyText={buildCopyText(unitPrice, qtyN, '개', total)}
                    payload={payload}
                />
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {unitPrice !== null && total !== null
                        ? `아크릴가다 ${tk} ${g.label} √(${wN}×${hN})≈${Math.ceil(root)}mm — ${g.textType} ${formatPrice(full)}÷2 = ${formatPrice(unitPrice)} × ${qtyN}개`
                        : (valid && root > 890
                            ? `√(가로×세로)≈${Math.ceil(root)}mm — 890mm 까지만 등록되어 있습니다`
                            : (valid ? '해당 조합에 등록된 단가가 없습니다' : (size.trim() ? '530*110 또는 530 110 형식으로 입력하세요' : '가로*세로를 입력하세요')))}
                </div>
            </div>
        </div>
    )
}
