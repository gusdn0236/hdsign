import { useEffect, useMemo, useState } from 'react'

/**
 * 변경점 검토 모달.
 *
 * baseline 의 모든 사이즈/타입을 PricesViewerModal 과 동일한 표 구조로 노출하고,
 * 변경된 셀만 굵게 강조한다. 행/열 위치는 옛 단가표 엑셀과 같은 모양.
 *
 *   - 변경 없는 셀:  baseline 가격 (회색)
 *   - 변경 있는 셀:  옛 가격(취소선) + 새 가격(굵게 컬러) + % + 의심 태그
 *   - 셀 클릭 → 적용/유지 토글
 *
 * 적용 클릭 → 확인 다이얼로그 → onApply(decisions).
 */

const CAT_LABELS = {
    channel:    '잔넬',
    gomu:       '고무스카시',
    acryl:      '아크릴/포맥스',
    epoxy:      '에폭시',
    goldSilver: '금은경',
}

const TT_LABELS = {
    korean: '한글', englishNumber: '영문/숫자', '한글': '한글', '영문': '영문',
}

const MAT_LABELS = {
    galvalume: '갈바', stainless: '스텐', gold: '금경', silver: '은경',
}

const SUSPICION_META = {
    digit_missing:      { label: '0누락', tone: 'high' },
    extra_digit:        { label: '0추가', tone: 'high' },
    monotonicity_break: { label: '이상치', tone: 'medium' },
    price_decreased:    { label: '하락',   tone: 'medium' },
    clean_change:       { label: '인상',   tone: 'ok' },
}

function isSuspicious(item) {
    return item.severity === 'high' || item.severity === 'medium'
}

function sortBands(bands) {
    return bands.slice().sort((a, b) => bandSortKey(a) - bandSortKey(b))
}
function bandSortKey(band) {
    const cleaned = String(band).replace(/mm/g, '').replace(/\s/g, '')
    if (cleaned.startsWith('~')) return parseInt(cleaned.slice(1), 10) || 0
    const m = cleaned.match(/^(\d+)/)
    return m ? parseInt(m[1], 10) : 0
}

export default function ReviewModal({ diff, baseline, fileName, onCancel, onApply }) {
    // 변경 항목이 있는 카테고리만 노출
    const availableCats = useMemo(() => {
        if (!diff) return []
        return Object.keys(diff.calculators).filter(c => diff.calculators[c].diffs?.length > 0)
    }, [diff])

    const singleCat = availableCats.length === 1
    const [activeCat, setActiveCat] = useState(availableCats[0] || '')

    const allItems = useMemo(() => {
        if (!diff) return []
        const out = []
        for (const [calcKey, calc] of Object.entries(diff.calculators)) {
            for (const item of calc.diffs) out.push({ ...item, calcKey })
        }
        return out
    }, [diff])

    const initialDecisions = useMemo(() => {
        const d = {}
        for (const item of allItems) {
            // missing_in_excel = 가격 시프트로 큰 사이즈가 빠진 경우 — 자동 체크(인상처럼)
            //   작은 사이즈 빈칸은 parseXlsx 에서 미리 baseline 값으로 채워서 여기까지 안 옴
            if (item.status === 'missing_in_excel')   d[item.path] = 'excel'
            else if (isSuspicious(item))              d[item.path] = 'baseline'
            else                                       d[item.path] = 'excel'
        }
        return d
    }, [allItems])

    const [decisions, setDecisions] = useState(initialDecisions)
    const [confirming, setConfirming] = useState(false)

    useEffect(() => { setDecisions(initialDecisions) }, [initialDecisions])

    // body 스크롤 잠금 — 모달 뒤 페이지 안 움직이게
    useEffect(() => {
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { document.body.style.overflow = prev }
    }, [])

    useEffect(() => {
        function onKey(e) {
            if (e.key === 'Escape') {
                if (confirming) setConfirming(false)
                else onCancel()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel, confirming])

    function setDecision(path, value) {
        setDecisions(d => ({ ...d, [path]: value }))
    }

    function toggleCell(item) {
        if (!item) return
        const cur = decisions[item.path]
        setDecision(item.path, cur === 'excel' ? 'baseline' : 'excel')
    }

    function bulkSet(items, value) {
        setDecisions(d => {
            const next = { ...d }
            for (const it of items) next[it.path] = value
            return next
        })
    }

    // 한 컬럼(type/lang)의 모든 변경 셀을 일괄 토글. 모두 'excel' 이면 'baseline' 으로,
    // 아니면 모두 'excel' 로.
    function toggleColumn(pathPrefix) {
        const itemsInCol = allItems.filter(it => it.path.startsWith(pathPrefix + '.') || it.path.startsWith(pathPrefix))
        const filtered = itemsInCol.filter(it =>
            it.path === pathPrefix
            || it.path.startsWith(pathPrefix + '.')
        )
        if (filtered.length === 0) return
        const allOn = filtered.every(it => decisions[it.path] === 'excel')
        bulkSet(filtered, allOn ? 'baseline' : 'excel')
    }

    const stats = useMemo(() => {
        let toApply = 0, toKeep = 0, suspicious = 0
        for (const item of allItems) {
            if (isSuspicious(item)) suspicious++
            if (decisions[item.path] === 'excel') toApply++
            else toKeep++
        }
        return { toApply, toKeep, suspicious, total: allItems.length }
    }, [allItems, decisions])

    const activeCatItems = useMemo(
        () => allItems.filter(it => it.calcKey === activeCat),
        [allItems, activeCat],
    )

    const baselineCalc = baseline?.calculators?.[activeCat]

    return (
        <div className="qu-modal-backdrop">
            <div className="qu-modal qu-modal-lg" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">단계 2 / 2 · 바뀐 곳 확인</div>
                        <h2 className="qu-modal-title">
                            {singleCat ? `${CAT_LABELS[availableCats[0]]} 단가표 비교` : '단가표 비교'}
                            <span className="qu-modal-title-file">· {fileName}</span>
                        </h2>
                        <div className="qu-modal-sub">
                            기존 단가표에서 <strong className="qu-text-apply">{stats.toApply}</strong>곳이 변경된 것 같아요.
                            {stats.suspicious > 0 && <> · <span className="qu-text-warn">⚠ 오타로 의심되는 곳 {stats.suspicious}곳</span></>}
                        </div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onCancel} aria-label="닫기">×</button>
                </header>

                {!singleCat && availableCats.length > 1 && (
                    <div className="qu-modal-toolbar">
                        <div className="qu-tabs">
                            {availableCats.map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    className={`qu-tab ${activeCat === c ? 'active' : ''}`}
                                    onClick={() => setActiveCat(c)}
                                >
                                    {CAT_LABELS[c]}
                                    <span className="qu-tab-count">{diff.calculators[c].diffs.length}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="qu-bulk-bar">
                    <div className="qu-bulk-left">
                        <button type="button" className="qu-bulk-btn" onClick={() => bulkSet(activeCatItems, 'excel')}>전부 체크</button>
                        <button type="button" className="qu-bulk-btn" onClick={() => bulkSet(activeCatItems, 'baseline')}>전부 해제</button>
                        <button type="button" className="qu-bulk-btn" onClick={() => bulkSet(activeCatItems.filter(it => !isSuspicious(it)), 'excel')}>정상 인상만 체크</button>
                    </div>
                    <div className="qu-bulk-right">
                        <span className="qu-legend"><i className="qu-legend-dot tone-ok"/> 정상 인상</span>
                        <span className="qu-legend"><i className="qu-legend-dot tone-medium"/> 한번 더 확인</span>
                        <span className="qu-legend"><i className="qu-legend-dot tone-high"/> 위험 (0누락 등)</span>
                    </div>
                </div>

                <div className="qu-modal-body qu-modal-body-grid">
                    {activeCat && baselineCalc && (
                        <DiffGrid
                            calcKey={activeCat}
                            baselineCalc={baselineCalc}
                            diff={diff.calculators[activeCat]}
                            decisions={decisions}
                            onToggleCell={toggleCell}
                            onToggleColumn={toggleColumn}
                        />
                    )}
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>취소하고 처음으로</button>
                    <button
                        type="button"
                        className="qu-btn-apply"
                        onClick={() => setConfirming(true)}
                        disabled={stats.toApply === 0}
                    >
                        {stats.toApply === 0 ? '체크된 셀이 없어요' : `체크한 ${stats.toApply}곳 단가표에 반영하기`}
                    </button>
                </footer>

                {confirming && (
                    <ConfirmApplyDialog
                        toApply={stats.toApply}
                        toKeep={stats.toKeep}
                        suspiciousApplying={countSuspiciousApplying(allItems, decisions)}
                        onCancel={() => setConfirming(false)}
                        onConfirm={() => onApply(decisions)}
                    />
                )}
            </div>
        </div>
    )
}

function countSuspiciousApplying(allItems, decisions) {
    let n = 0
    for (const it of allItems) if (isSuspicious(it) && decisions[it.path] === 'excel') n++
    return n
}

/* ---------- 카테고리별 표 라우팅 ---------- */

function DiffGrid({ calcKey, baselineCalc, diff, decisions, onToggleCell, onToggleColumn }) {
    const itemByPath = useMemo(() => {
        const m = new Map()
        for (const it of diff.diffs) m.set(it.path, it)
        return m
    }, [diff])

    const common = { baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }

    if (calcKey === 'channel')    return <ChannelGrid    {...common} />
    if (calcKey === 'gomu')       return <GomuGrid       {...common} />
    if (calcKey === 'acryl')      return <AcrylGrid      {...common} />
    if (calcKey === 'epoxy')      return <EpoxyGrid      {...common} />
    if (calcKey === 'goldSilver') return <GoldSilverGrid {...common} />
    return null
}

/** 컬럼 헤더 — 클릭 시 그 컬럼 일괄 토글 */
function ColHeader({ pathPrefix, label, subLabel, onToggleColumn, className = 'num', ...rest }) {
    return (
        <th
            className={`${className} qu-col-head`}
            onClick={() => onToggleColumn?.(pathPrefix)}
            title="이 줄 전체 일괄 체크/해제"
            {...rest}
        >
            {label}
            {subLabel && <small>{subLabel}</small>}
            <span className="qu-col-head-hint">▼</span>
        </th>
    )
}

/* ---------- 공통 셀 ---------- */

function DiffCell({ baseValue, item, decisions, onToggleCell }) {
    if (!item) {
        return (
            <td className="qu-dc unchanged num">
                {baseValue != null ? baseValue.toLocaleString() : <span className="muted">—</span>}
            </td>
        )
    }
    const susp = item.suspicion ? SUSPICION_META[item.suspicion] : null
    const isBlank = item.status === 'missing_in_excel'
    const isNew = item.status === 'missing_in_baseline'
    // 빈칸 = 가격 시프트로 사이즈가 빠진 경우 — 정상 인상과 같은 ok 톤
    const tone = isBlank ? 'ok' : (susp?.tone || 'ok')
    const isOn = decisions[item.path] === 'excel'

    const b = item.baselineValue
    const x = item.excelValue
    const delta = (b != null && x != null) ? { d: x - b, pct: b ? ((x - b) / b * 100) : 0 } : null

    return (
        <td
            className={`qu-dc changed tone-${tone} ${isOn ? 'on' : 'off'} ${isBlank ? 'blank' : ''}`}
            onClick={() => onToggleCell(item)}
        >
            {(susp || isNew || isBlank) && (
                <div className="qu-dc-tags">
                    {susp && <span className={`qu-dc-tag tone-${susp.tone}`}>{susp.label}</span>}
                    {isNew && <span className="qu-dc-tag tone-info">신규</span>}
                    {isBlank && <span className="qu-dc-tag tone-ok">사이즈 제거</span>}
                </div>
            )}
            {b != null && <div className="qu-dc-old">{b.toLocaleString()}</div>}
            <div className="qu-dc-new">
                {isBlank ? <span className="qu-dc-removed">사이즈 빠짐</span> : (x != null ? x.toLocaleString() : '—')}
            </div>
            {delta && (
                <div className={`qu-dc-pct ${delta.d >= 0 ? 'pos' : 'neg'}`}>
                    {delta.pct >= 0 ? '+' : ''}{delta.pct.toFixed(1)}%
                </div>
            )}
            {isOn && <span className="qu-dc-check">✓</span>}
        </td>
    )
}

/* ---------- 잔넬 ---------- */

function ChannelGrid({ baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }) {
    const columns = []
    const sizeSet = new Set()
    for (const t of baselineCalc.types || []) {
        if (t.needsLang) {
            for (const lang of ['eng', 'kor']) {
                const m = t.pricesByLang?.[lang] || {}
                columns.push({ key: t.key, lang, label: t.label, subLabel: lang === 'eng' ? '영문' : '한글', prices: m, pathPrefix: `channel.${t.key}.${lang}` })
                Object.keys(m).forEach(s => sizeSet.add(+s))
            }
        } else {
            const m = t.prices || {}
            columns.push({ key: t.key, lang: null, label: t.label, prices: m, pathPrefix: `channel.${t.key}` })
            Object.keys(m).forEach(s => sizeSet.add(+s))
        }
    }
    const sizes = [...sizeSet].sort((a, b) => a - b)

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head">사이즈 (mm)</th>
                        {columns.map((c, i) => (
                            <ColHeader key={i} pathPrefix={c.pathPrefix} label={c.label} subLabel={c.subLabel} onToggleColumn={onToggleColumn} />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sizes.map(size => (
                        <tr key={size}>
                            <td className="qu-grid-row-head">{size}</td>
                            {columns.map((c, i) => {
                                const baseValue = c.prices[size]
                                const path = c.lang ? `channel.${c.key}.${c.lang}.${size}` : `channel.${c.key}.${size}`
                                return <DiffCell key={i} baseValue={baseValue} item={itemByPath.get(path)} decisions={decisions} onToggleCell={onToggleCell} />
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 고무스카시 ---------- */

function GomuGrid({ baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }) {
    const prices = baselineCalc.prices || {}
    const thicknesses = Object.keys(prices)
    const bandSet = new Set()
    for (const tk of thicknesses) {
        Object.keys(prices[tk] || {}).forEach(b => bandSet.add(b))
    }
    const bands = sortBands([...bandSet])

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head">사이즈 (mm)</th>
                        {thicknesses.map(tk => (
                            <ColHeader key={tk} pathPrefix={`gomu.${tk}`} label={tk} onToggleColumn={onToggleColumn} />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {thicknesses.map(tk => {
                                const baseValue = prices[tk]?.[band]
                                return <DiffCell key={tk} baseValue={baseValue} item={itemByPath.get(`gomu.${tk}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 아크릴 ---------- */

function AcrylGrid({ baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }) {
    const prices = baselineCalc.prices || {}
    const thicknesses = Object.keys(prices)
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

    const columns = []
    for (const tk of thicknesses) {
        for (const tt of textTypes) columns.push({ tk, tt })
    }

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head" rowSpan={2}>사이즈 (mm)</th>
                        {thicknesses.map(tk => (
                            <th key={tk} className="qu-grid-group" colSpan={textTypes.length}>{tk}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <ColHeader key={i} pathPrefix={`acryl.${c.tk}.${c.tt}`} label="" subLabel={TT_LABELS[c.tt] || c.tt} onToggleColumn={onToggleColumn} />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {columns.map((c, i) => {
                                const baseValue = prices[c.tk]?.[c.tt]?.[band]
                                return <DiffCell key={i} baseValue={baseValue} item={itemByPath.get(`acryl.${c.tk}.${c.tt}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 에폭시 ---------- */

const EPOXY_STROKES_DEFAULT = ['30', '50', '70', '90', '110']

function EpoxyGrid({ baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }) {
    const prices = baselineCalc.prices || {}
    const materials = Object.keys(prices)

    const blocks = []
    for (const mat of materials) {
        for (const tt of Object.keys(prices[mat] || {})) {
            const sizeMap = prices[mat][tt] || {}
            const sizes = Object.keys(sizeMap).sort((a, b) => +a - +b)
            const strokeSet = new Set()
            for (const s of sizes) Object.keys(sizeMap[s] || {}).forEach(k => strokeSet.add(k))
            const strokes = [...strokeSet].sort((a, b) => +a - +b)
            blocks.push({ mat, tt, sizes, strokes, sizeMap })
        }
    }

    if (blocks.length === 0) return <div className="qu-empty">데이터가 없어요.</div>

    return (
        <div className="qu-epoxy-blocks">
            {blocks.map((blk, idx) => (
                <div key={idx} className="qu-epoxy-block">
                    <div className="qu-epoxy-block-title">
                        {MAT_LABELS[blk.mat] || blk.mat} · {TT_LABELS[blk.tt] || blk.tt}
                    </div>
                    <div className="qu-grid-scroll">
                        <table className="qu-grid">
                            <thead>
                                <tr>
                                    <th className="qu-grid-row-head">사이즈</th>
                                    {(blk.strokes.length ? blk.strokes : EPOXY_STROKES_DEFAULT).map(st => (
                                        <th key={st} className="num">{st}획</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {blk.sizes.map(size => (
                                    <tr key={size}>
                                        <td className="qu-grid-row-head">~{size}</td>
                                        {(blk.strokes.length ? blk.strokes : EPOXY_STROKES_DEFAULT).map(st => {
                                            const baseValue = blk.sizeMap[size]?.[st]
                                            return <DiffCell key={st} baseValue={baseValue} item={itemByPath.get(`epoxy.${blk.mat}.${blk.tt}.${size}.${st}`)} decisions={decisions} onToggleCell={onToggleCell} />
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

/* ---------- 금은경 ---------- */

function GoldSilverGrid({ baselineCalc, itemByPath, decisions, onToggleCell, onToggleColumn }) {
    const prices = baselineCalc.prices || {}
    const materials = Object.keys(prices)
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

    const matGroups = []
    for (const c of columns) {
        const last = matGroups[matGroups.length - 1]
        if (last && last.mat === c.mat) last.count++
        else matGroups.push({ mat: c.mat, count: 1 })
    }

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head" rowSpan={2}>사이즈 (mm)</th>
                        {matGroups.map((g, i) => (
                            <th key={i} colSpan={g.count} className="qu-grid-group">{MAT_LABELS[g.mat] || g.mat}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <ColHeader key={i} pathPrefix={`goldSilver.${c.mat}.${c.tk}.${c.tt}`} label={c.tk} subLabel={TT_LABELS[c.tt] || c.tt} onToggleColumn={onToggleColumn} />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {columns.map((c, i) => {
                                const baseValue = prices[c.mat]?.[c.tk]?.[c.tt]?.[band]
                                return <DiffCell key={i} baseValue={baseValue} item={itemByPath.get(`goldSilver.${c.mat}.${c.tk}.${c.tt}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 확인 다이얼로그 ---------- */

function ConfirmApplyDialog({ toApply, toKeep, suspiciousApplying, onCancel, onConfirm }) {
    return (
        <div className="qu-confirm-backdrop" onClick={onCancel}>
            <div className="qu-confirm" onClick={e => e.stopPropagation()}>
                <div className="qu-confirm-title">정말 단가표에 반영할까요?</div>
                <div className="qu-confirm-body">
                    <div className="qu-confirm-line">
                        <strong className="big">{toApply}</strong>곳이 새 단가로 바뀝니다.
                    </div>
                    {toKeep > 0 && (
                        <div className="qu-confirm-line muted">
                            나머지 {toKeep}곳은 지금 단가 그대로 유지돼요.
                        </div>
                    )}
                    {suspiciousApplying > 0 && (
                        <div className="qu-confirm-warn">
                            ⚠ 오타로 의심되는 곳(0누락/이상치 등) 중 <strong>{suspiciousApplying}곳</strong>이 포함돼 있어요.
                        </div>
                    )}
                    <div className="qu-confirm-meta">
                        이전 단가표는 자동으로 백업되니, 잘못 반영해도 다시 되돌릴 수 있어요.
                    </div>
                </div>
                <div className="qu-confirm-actions">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>잠깐, 다시 볼게요</button>
                    <button type="button" className="qu-btn-apply" onClick={onConfirm}>네, 반영할게요</button>
                </div>
            </div>
        </div>
    )
}
