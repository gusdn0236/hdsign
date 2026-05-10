import { useState, useMemo } from 'react'
import { formatPrice, goldSilverBandForHeight } from './helpers'

function isMissingCombo(missingTextTypes, mat, thickness, tt) {
    return (missingTextTypes || []).some(
        m => m.material === mat && m.thickness === thickness && m.missing.includes(tt)
    )
}

export default function GoldSilverCalc({ prices }) {
    const calc = prices.calculators.goldSilver
    const { material, thicknessByMaterial, textType, missingTextTypes } = calc.axes
    const [matKey, setMatKey] = useState(material[0].key)
    const [tk, setTk] = useState(thicknessByMaterial[material[0].key][0])
    const [tt, setTt] = useState(textType[0])
    const [height, setHeight] = useState('50')
    const [qty, setQty] = useState('1')

    const thicknesses = thicknessByMaterial[matKey]

    // 재질 변경 시 — 그 재질에 없는 두께면 첫 번째로, 없는 textType이면 영문으로 리셋
    function changeMaterial(m) {
        setMatKey(m)
        const newThicknesses = thicknessByMaterial[m]
        const nextTk = newThicknesses.includes(tk) ? tk : newThicknesses[0]
        if (nextTk !== tk) setTk(nextTk)
        if (isMissingCombo(missingTextTypes, m, nextTk, tt)) setTt(textType[0])
    }

    function changeThickness(newTk) {
        setTk(newTk)
        if (isMissingCombo(missingTextTypes, matKey, newTk, tt)) setTt(textType[0])
    }

    const isMissing = useMemo(
        () => isMissingCombo(missingTextTypes, matKey, tk, tt),
        [matKey, tk, tt, missingTextTypes],
    )

    const heightMm = parseInt(height, 10)
    const qtyN = parseInt(qty, 10)
    const band = Number.isFinite(heightMm) && heightMm > 0 ? goldSilverBandForHeight(heightMm) : null
    const unitPrice = !isMissing && band
        ? calc.prices?.[matKey]?.[tk]?.[tt]?.[band] ?? null
        : null
    const total = unitPrice !== null && Number.isFinite(qtyN) && qtyN > 0 ? unitPrice * qtyN : null
    const matLabel = material.find(m => m.key === matKey)?.label

    return (
        <div className="calc-card">
            <h2 className="calc-title">{calc.label}</h2>

            <div className="calc-form">
                <label className="calc-field">
                    <span>재질</span>
                    <select value={matKey} onChange={e => changeMaterial(e.target.value)}>
                        {material.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>두께</span>
                    <select value={tk} onChange={e => changeThickness(e.target.value)}>
                        {thicknesses.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>

                <label className="calc-field">
                    <span>종류</span>
                    <select value={tt} onChange={e => setTt(e.target.value)}>
                        {textType.map(t => {
                            const disabled = isMissingCombo(missingTextTypes, matKey, tk, t)
                            return <option key={t} value={t} disabled={disabled}>
                                {t}{disabled ? ' (없음)' : ''}
                            </option>
                        })}
                    </select>
                </label>

                <label className="calc-field">
                    <span>높이 (mm)</span>
                    <input
                        type="number" min="1" value={height}
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
                        ? `${matLabel} ${tk} ${tt} ${heightMm}mm 밴드(${band}) — ${formatPrice(unitPrice)} × ${qtyN}개`
                        : (Number.isFinite(heightMm) && heightMm > 0
                            ? '해당 조합에 등록된 단가가 없습니다'
                            : '높이/수량을 입력하세요')}
                </div>
            </div>
        </div>
    )
}
