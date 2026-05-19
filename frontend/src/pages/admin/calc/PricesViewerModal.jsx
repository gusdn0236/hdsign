import { useEffect, useState } from 'react'

/**
 * 현재 적용 중인 단가표를 카테고리별 표로 보여주는 모달.
 *
 * 카테고리별로 데이터 구조가 달라 표 컴포넌트도 따로:
 *  channel    : 행=사이즈(mm), 열=잔넬 type (한/영 분리)
 *  gomu       : 행=사이즈밴드, 열=두께 6종
 *  acryl      : 행=사이즈밴드, 열=두께 × 텍스트타입
 *  epoxy      : 재질·텍스트타입별 sub-table 4개, 행=사이즈, 열=스트로크
 *  goldSilver : 행=사이즈밴드, 열=재질 × 두께 × 텍스트타입
 */

const CATEGORY_LABELS = {
    channel:    '잔넬',
    gomu:       '고무스카시',
    acryl:      '아크릴/포맥스',
    epoxy:      '에폭시',
    goldSilver: '금은경',
}

const TT_LABELS = {
    korean: '한글',
    englishNumber: '영문/숫자',
    '한글': '한글',
    '영문': '영문',
}

const MAT_LABELS = {
    galvalume: '갈바',
    stainless: '스텐',
    gold: '금경',
    silver: '은경',
}

export default function PricesViewerModal({ prices, onClose }) {
    const calculators = prices?.calculators || {}
    const availableCats = Object.keys(CATEGORY_LABELS).filter(c => calculators[c])
    const [activeCat, setActiveCat] = useState(availableCats[0] || 'channel')

    useEffect(() => {
        function onKey(e) { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    // body 스크롤 잠금 — 모달 뒤 페이지 안 움직이게
    useEffect(() => {
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { document.body.style.overflow = prev }
    }, [])

    const meta = prices?._meta
    const calc = calculators[activeCat]

    return (
        <div className="qu-modal-backdrop" onClick={onClose}>
            <div className="qu-modal qu-modal-lg" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">현재 단가표</div>
                        <h2 className="qu-modal-title">지금 적용 중인 단가 한눈에 보기</h2>
                        <div className="qu-modal-sub">
                            {meta?.builtAt
                                ? <>마지막 갱신: <strong>{new Date(meta.builtAt).toLocaleString('ko-KR')}</strong></>
                                : '아직 한 번도 갱신되지 않은 초기 단가표예요'}
                            {meta?.sourceXlsx && <> · 원본: {meta.sourceXlsx}</>}
                        </div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onClose} aria-label="닫기">×</button>
                </header>

                <div className="qu-modal-toolbar">
                    <div className="qu-tabs">
                        {availableCats.map(c => (
                            <button
                                key={c}
                                type="button"
                                className={`qu-tab ${activeCat === c ? 'active' : ''}`}
                                onClick={() => setActiveCat(c)}
                            >{CATEGORY_LABELS[c]}</button>
                        ))}
                    </div>
                </div>

                <div className="qu-modal-body qu-modal-body-table">
                    {calc ? (
                        activeCat === 'channel'    ? <ChannelTable calc={calc} /> :
                        activeCat === 'gomu'       ? <GomuTable calc={calc} /> :
                        activeCat === 'acryl'      ? <AcrylTable calc={calc} /> :
                        activeCat === 'epoxy'      ? <EpoxyTable calc={calc} /> :
                        activeCat === 'goldSilver' ? <GoldSilverTable calc={calc} /> :
                        null
                    ) : (
                        <div className="qu-empty">이 카테고리의 단가 데이터가 없어요.</div>
                    )}
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-apply" onClick={onClose}>닫기</button>
                </footer>
            </div>
        </div>
    )
}

/* ---------- 카테고리별 표 ---------- */

function ChannelTable({ calc }) {
    // type 각각이 한 열(needsLang=true 면 한/영 두 열) → 사이즈 합집합 → 행
    const columns = []
    const sizeSet = new Set()
    for (const t of calc.types || []) {
        if (t.needsLang) {
            for (const lang of ['eng', 'kor']) {
                const m = t.pricesByLang?.[lang] || {}
                columns.push({
                    label: t.label,
                    subLabel: lang === 'eng' ? '영문' : '한글',
                    prices: m,
                })
                Object.keys(m).forEach(s => sizeSet.add(s))
            }
        } else {
            const m = t.prices || {}
            columns.push({ label: t.label, subLabel: null, prices: m })
            Object.keys(m).forEach(s => sizeSet.add(s))
        }
    }
    const sizes = [...sizeSet].sort((a, b) => +a - +b)

    return (
        <div className="qu-prices-scroll">
            <table className="qu-prices-table">
                <thead>
                    <tr>
                        <th className="sticky-col">사이즈 (mm)</th>
                        {columns.map((c, i) => (
                            <th key={i} className="num">
                                {c.label}
                                {c.subLabel && <small>{c.subLabel}</small>}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sizes.map(size => (
                        <tr key={size}>
                            <td className="sticky-col size-head">{size}</td>
                            {columns.map((c, i) => (
                                <td key={i} className="num">
                                    {c.prices[size] != null ? c.prices[size].toLocaleString() : <span className="muted">—</span>}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function GomuTable({ calc }) {
    // calc.prices: { thickness: { band: price } }
    const prices = calc.prices || {}
    const thicknesses = Object.keys(prices)
    const bandSet = new Set()
    for (const tk of thicknesses) {
        Object.keys(prices[tk] || {}).forEach(b => bandSet.add(b))
    }
    const bands = sortBands([...bandSet])

    return (
        <div className="qu-prices-scroll">
            <table className="qu-prices-table">
                <thead>
                    <tr>
                        <th className="sticky-col">사이즈 (mm)</th>
                        {thicknesses.map(tk => (
                            <th key={tk} className="num">{tk}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="sticky-col size-head">{band}</td>
                            {thicknesses.map(tk => {
                                const v = prices[tk]?.[band]
                                return (
                                    <td key={tk} className="num">
                                        {v != null ? v.toLocaleString() : <span className="muted">—</span>}
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function AcrylTable({ calc }) {
    // calc.prices: { thickness: { textType: { band: price } } }
    const prices = calc.prices || {}
    const thicknesses = Object.keys(prices)
    // 모든 textType 수집(순서 유지)
    const ttSet = new Set()
    const bandSet = new Set()
    for (const tk of thicknesses) {
        for (const tt of Object.keys(prices[tk] || {})) {
            ttSet.add(tt)
            for (const b of Object.keys(prices[tk][tt] || {})) bandSet.add(b)
        }
    }
    const textTypes = [...ttSet]
    const bands = sortBands([...bandSet])

    // 열: thickness × textType
    const columns = []
    for (const tk of thicknesses) {
        for (const tt of textTypes) {
            columns.push({ thickness: tk, textType: tt })
        }
    }

    return (
        <div className="qu-prices-scroll">
            <table className="qu-prices-table">
                <thead>
                    <tr>
                        <th className="sticky-col" rowSpan={2}>사이즈 (mm)</th>
                        {thicknesses.map(tk => (
                            <th key={tk} className="group-head" colSpan={textTypes.length}>{tk}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <th key={i} className="num sub-head">{TT_LABELS[c.textType] || c.textType}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="sticky-col size-head">{band}</td>
                            {columns.map((c, i) => {
                                const v = prices[c.thickness]?.[c.textType]?.[band]
                                return (
                                    <td key={i} className="num">
                                        {v != null ? v.toLocaleString() : <span className="muted">—</span>}
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function EpoxyTable({ calc }) {
    // calc.prices: { material: { textType: { size: { stroke: price } } } }
    // 재질·텍스트타입별 sub-table 4개. 각 sub-table: 행=사이즈, 열=stroke.
    const prices = calc.prices || {}
    const materials = Object.keys(prices)

    const blocks = []
    for (const mat of materials) {
        for (const tt of Object.keys(prices[mat] || {})) {
            const sizeMap = prices[mat][tt] || {}
            const sizes = Object.keys(sizeMap).sort((a, b) => +a - +b)
            // 모든 stroke 수집
            const strokeSet = new Set()
            for (const s of sizes) Object.keys(sizeMap[s] || {}).forEach(k => strokeSet.add(k))
            const strokes = [...strokeSet].sort((a, b) => +a - +b)
            blocks.push({ mat, tt, sizes, strokes, sizeMap })
        }
    }

    if (blocks.length === 0) return <div className="qu-empty">에폭시 단가가 없어요.</div>

    return (
        <div className="qu-prices-blocks">
            {blocks.map((blk, idx) => (
                <div key={idx} className="qu-prices-block">
                    <div className="qu-prices-block-title">
                        {MAT_LABELS[blk.mat] || blk.mat} · {TT_LABELS[blk.tt] || blk.tt}
                    </div>
                    <div className="qu-prices-scroll">
                        <table className="qu-prices-table">
                            <thead>
                                <tr>
                                    <th className="sticky-col">사이즈 (mm)</th>
                                    {blk.strokes.map(st => (
                                        <th key={st} className="num">{st}획</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {blk.sizes.map(s => (
                                    <tr key={s}>
                                        <td className="sticky-col size-head">~{s}</td>
                                        {blk.strokes.map(st => {
                                            const v = blk.sizeMap[s]?.[st]
                                            return (
                                                <td key={st} className="num">
                                                    {v != null ? v.toLocaleString() : <span className="muted">—</span>}
                                                </td>
                                            )
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    )
}

function GoldSilverTable({ calc }) {
    // calc.prices: { material: { thickness: { textType: { band: price } } } }
    const prices = calc.prices || {}
    const materials = Object.keys(prices)

    // 모든 (material, thickness, textType) 열 만들기 + band 수집
    const columns = []
    const bandSet = new Set()
    for (const mat of materials) {
        for (const tk of Object.keys(prices[mat] || {})) {
            for (const tt of Object.keys(prices[mat][tk] || {})) {
                columns.push({ mat, tk, tt })
                for (const b of Object.keys(prices[mat][tk][tt] || {})) bandSet.add(b)
            }
        }
    }
    const bands = sortBands([...bandSet])

    // 그룹 헤더: material 별로 묶음
    const matGroups = []
    let cur = null
    for (const col of columns) {
        if (!cur || cur.mat !== col.mat) {
            cur = { mat: col.mat, count: 0 }
            matGroups.push(cur)
        }
        cur.count++
    }

    return (
        <div className="qu-prices-scroll">
            <table className="qu-prices-table">
                <thead>
                    <tr>
                        <th className="sticky-col" rowSpan={2}>사이즈 (mm)</th>
                        {matGroups.map((g, i) => (
                            <th key={i} className="group-head" colSpan={g.count}>{MAT_LABELS[g.mat] || g.mat}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <th key={i} className="num sub-head">
                                {c.tk}
                                <small>{TT_LABELS[c.tt] || c.tt}</small>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="sticky-col size-head">{band}</td>
                            {columns.map((c, i) => {
                                const v = prices[c.mat]?.[c.tk]?.[c.tt]?.[band]
                                return (
                                    <td key={i} className="num">
                                        {v != null ? v.toLocaleString() : <span className="muted">—</span>}
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- helpers ---------- */

function sortBands(bands) {
    return bands.slice().sort((a, b) => bandSortKey(a) - bandSortKey(b))
}

function bandSortKey(band) {
    const cleaned = String(band).replace(/mm/g, '').replace(/\s/g, '')
    if (cleaned.startsWith('~')) return parseInt(cleaned.slice(1), 10) || 0
    const m = cleaned.match(/^(\d+)/)
    return m ? parseInt(m[1], 10) : 0
}
