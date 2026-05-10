import { useState } from 'react'
import { formatPrice, channelSizes } from './helpers'

const FONT_OPTIONS = [
    { key: 'headLine', label: '헤드라인체' },
    { key: 'godik',    label: '고딕체' },
    { key: 'square',   label: '정사각형' },
    { key: 'circle',   label: '원형' },
]

export default function LedCalc({ prices }) {
    const led = prices.calculators.led
    const channelSizesList = channelSizes(prices.calculators.channel.sizeAxis)
    const ledSizes = Object.keys(led.ledCount).map(Number).sort((a, b) => a - b)
    const [size, setSize] = useState(ledSizes[0] || 200)
    const [font, setFont] = useState('headLine')
    const [letters, setLetters] = useState('1')

    const lettersN = parseInt(letters, 10)
    const counts = led.ledCount[String(size)]
    const ledPerLetter = counts ? counts[font] : null
    const totalLeds = ledPerLetter !== null && ledPerLetter !== undefined
        && Number.isFinite(lettersN) && lettersN > 0
        ? ledPerLetter * lettersN : null

    // 200/250mm + 헤드라인·고딕은 미들2구(740), 그 외 KPL(750)
    const useMid2 = led.rules.useMid2When.sizes.includes(size)
        && led.rules.useMid2When.fonts.includes(font)
    const unitPrice = useMid2 ? led.componentPrices.mid2 : led.componentPrices.kpl
    const componentLabel = useMid2 ? '미들2구' : 'KPL'

    const total = totalLeds !== null ? totalLeds * unitPrice : null

    return (
        <div className="calc-card">
            <h2 className="calc-title">{led.label}</h2>
            <p className="calc-note">{led._note}</p>

            <div className="calc-form">
                <label className="calc-field">
                    <span>잔넬 사이즈 (mm)</span>
                    <select value={size} onChange={e => setSize(Number(e.target.value))}>
                        {ledSizes.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>

                <div className="calc-field">
                    <span>글씨체 / 모양</span>
                    <div className="seg">
                        {FONT_OPTIONS.map(f => (
                            <button
                                key={f.key}
                                type="button"
                                className={`seg-btn ${font === f.key ? 'active' : ''}`}
                                onClick={() => setFont(f.key)}
                            >{f.label}</button>
                        ))}
                    </div>
                </div>

                <label className="calc-field">
                    <span>글자 수</span>
                    <input
                        type="number" min="1" value={letters}
                        onChange={e => setLetters(e.target.value)}
                    />
                </label>
            </div>

            <div className="calc-result">
                <div className="calc-result-num">{formatPrice(total)}</div>
                <div className="calc-result-sub">
                    {ledPerLetter && totalLeds
                        ? `글자당 ${ledPerLetter}개 × ${lettersN}글자 = ${componentLabel} ${totalLeds}개 조립 (개당 ${unitPrice}원)`
                        : (ledPerLetter ? '글자 수를 입력하세요' : '해당 사이즈는 LED 데이터가 없습니다')}
                </div>
            </div>
        </div>
    )
}
