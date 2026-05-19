import { useEffect, useMemo, useState } from 'react'

/**
 * 변경점 검토 모달.
 *
 * 업로드한 엑셀의 원래 모양(행=사이즈/밴드, 열=type) 그대로 표로 보여주고,
 * 변경된 셀만 시각적으로 강조한다. 사용자가 잔넬만 업로드하면 잔넬 표만 노출.
 *
 * 셀 표시:
 *   - 변경 없음:  회색 작은 가격
 *   - 변경 있음:  취소선 옛 가격 + 굵은 새 가격 + 퍼센트 변화
 *   - 셀 클릭 → 적용/유지 토글
 *   - 의심(0누락/이상치/하락): 배경 톤 + 짧은 태그
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

const TYPE_LABELS = {
    galvaBackEng: '갈바후광 영문', galvaBackKor: '갈바후광 한글',
    galvaOsai: '갈바오사이',        galvaCap: '갈바캡잔넬',
    ilcheType: '일체형',            takaType: '타카',
    stenAlumCap: '스텐알미늄캡',    stenOsai: '스텐오사이',
    stenBack: '스텐후광',           goldSten: '골드스텐',
}

const TT_LABELS = {
    korean: '한글', englishNumber: '영문/숫자', '한글': '한글', '영문': '영문',
}

const MAT_LABELS = {
    galvalume: '갈바', stainless: '스텐', gold: '금경', silver: '은경',
}

const SUSPICION_META = {
    digit_missing:      { label: '0누락',   tone: 'high' },
    extra_digit:        { label: '0추가',   tone: 'high' },
    monotonicity_break: { label: '이상치',  tone: 'medium' },
    price_decreased:    { label: '하락',    tone: 'medium' },
    clean_change:       { label: '인상',    tone: 'ok' },
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

export default function ReviewModal({ diff, fileName, onCancel, onApply }) {
    // 변경점이 있는 카테고리만 노출 (parsed 에 들어있고 변경 셀이 있는 카테고리)
    const availableCats = useMemo(() => {
        if (!diff) return []
        return Object.keys(diff.calculators).filter(c => {
            const calc = diff.calculators[c]
            return calc.diffs?.length > 0
        })
    }, [diff])

    const singleCat = availableCats.length === 1
    const [activeCat, setActiveCat] = useState(availableCats[0] || '')

    // diff items 전부 (모든 카테고리)
    const allItems = useMemo(() => {
        if (!diff) return []
        const out = []
        for (const [calcKey, calc] of Object.entries(diff.calculators)) {
            for (const item of calc.diffs) out.push({ ...item, calcKey })
        }
        return out
    }, [diff])

    // 기본 결정: 정상 인상 ON, 의심 OFF, 빈칸 baseline 유지
    const initialDecisions = useMemo(() => {
        const d = {}
        for (const item of allItems) {
            if (item.status === 'missing_in_excel')   d[item.path] = 'baseline'
            else if (isSuspicious(item))              d[item.path] = 'baseline'
            else                                       d[item.path] = 'excel'
        }
        return d
    }, [allItems])

    const [decisions, setDecisions] = useState(initialDecisions)
    const [confirming, setConfirming] = useState(false)

    useEffect(() => { setDecisions(initialDecisions) }, [initialDecisions])

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
        if (item.status === 'missing_in_excel') return
        const cur = decisions[item.path]
        setDecision(item.path, cur === 'excel' ? 'baseline' : 'excel')
    }

    function bulkSet(items, value) {
        setDecisions(d => {
            const next = { ...d }
            for (const it of items) {
                if (it.status === 'missing_in_excel') continue
                next[it.path] = value
            }
            return next
        })
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

    // 활성 카테고리의 변경 항목 (일괄 액션에 사용)
    const activeCatItems = useMemo(
        () => allItems.filter(it => it.calcKey === activeCat),
        [allItems, activeCat],
    )

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
                            바뀐 셀 <strong>{stats.total}</strong>곳 중 <strong className="qu-text-apply">{stats.toApply}</strong>곳을 새 단가로 바꿔요.
                            {stats.suspicious > 0 && <> · <span className="qu-text-warn">⚠ 한 번 더 봐줄 셀 {stats.suspicious}곳</span></>}
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
                                    <span className="qu-tab-count">
                                        {diff.calculators[c].diffs.length}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="qu-bulk-bar">
                    <div className="qu-bulk-left">
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            onClick={() => bulkSet(activeCatItems, 'excel')}
                        >전부 체크</button>
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            onClick={() => bulkSet(activeCatItems, 'baseline')}
                        >전부 해제</button>
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            onClick={() => bulkSet(activeCatItems.filter(it => !isSuspicious(it)), 'excel')}
                        >정상 인상만 체크</button>
                    </div>
                    <div className="qu-bulk-right">
                        <span className="qu-legend"><i className="qu-legend-dot tone-ok"/> 정상 인상</span>
                        <span className="qu-legend"><i className="qu-legend-dot tone-medium"/> 한번 더 확인</span>
                        <span className="qu-legend"><i className="qu-legend-dot tone-high"/> 위험 (0 누락 등)</span>
                    </div>
                </div>

                <div className="qu-modal-body qu-modal-body-grid">
                    {activeCat && (
                        <DiffGrid
                            calcKey={activeCat}
                            diff={diff.calculators[activeCat]}
                            decisions={decisions}
                            onToggleCell={toggleCell}
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
                        {stats.toApply === 0
                            ? '체크된 셀이 없어요'
                            : `체크한 ${stats.toApply}곳 단가표에 반영하기`}
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

function DiffGrid({ calcKey, diff, decisions, onToggleCell }) {
    // diff.diffs 를 path 별 map 으로
    const itemByPath = useMemo(() => {
        const m = new Map()
        for (const it of diff.diffs) m.set(it.path, it)
        return m
    }, [diff])

    if (calcKey === 'channel')    return <ChannelGrid    diff={diff} itemByPath={itemByPath} decisions={decisions} onToggleCell={onToggleCell} />
    if (calcKey === 'gomu')       return <GomuGrid       diff={diff} itemByPath={itemByPath} decisions={decisions} onToggleCell={onToggleCell} />
    if (calcKey === 'acryl')      return <AcrylGrid      diff={diff} itemByPath={itemByPath} decisions={decisions} onToggleCell={onToggleCell} />
    if (calcKey === 'epoxy')      return <EpoxyGrid      diff={diff} itemByPath={itemByPath} decisions={decisions} onToggleCell={onToggleCell} />
    if (calcKey === 'goldSilver') return <GoldSilverGrid diff={diff} itemByPath={itemByPath} decisions={decisions} onToggleCell={onToggleCell} />
    return null
}

/* ---------- 공통 셀 ---------- */

function DiffCell({ item, decisions, onToggleCell }) {
    if (!item) {
        // 변경 없음 — diff 에 없는 셀. 공백.
        return <td className="qu-dc unchanged">&nbsp;</td>
    }
    const susp = item.suspicion ? SUSPICION_META[item.suspicion] : null
    const tone = susp?.tone || 'neutral'
    const isOn = decisions[item.path] === 'excel'
    const isBlank = item.status === 'missing_in_excel'
    const isNew = item.status === 'missing_in_baseline'

    const b = item.baselineValue
    const x = item.excelValue
    const delta = (b != null && x != null) ? { d: x - b, pct: b ? ((x - b) / b * 100) : 0 } : null

    return (
        <td
            className={`qu-dc tone-${tone} ${isOn ? 'on' : 'off'} ${isBlank ? 'blank' : ''} ${isNew ? 'new' : ''}`}
            onClick={() => onToggleCell(item)}
        >
            {susp && <span className={`qu-dc-tag tone-${susp.tone}`}>{susp.label}</span>}
            {isNew && <span className="qu-dc-tag tone-info">신규</span>}
            {isBlank && <span className="qu-dc-tag tone-info">빈칸</span>}

            {b != null && (
                <div className="qu-dc-old">{b.toLocaleString()}</div>
            )}
            <div className="qu-dc-new">
                {x != null ? x.toLocaleString() : '—'}
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

/* ---------- 잔넬 표 ---------- */

const CHANNEL_TYPE_ORDER = [
    'galvaBackEng', 'galvaBackKor', 'galvaOsai', 'galvaCap', 'ilcheType',
    'takaType', 'stenAlumCap', 'stenOsai', 'stenBack', 'goldSten',
]

const CHANNEL_NEEDS_LANG = new Set([
    'galvaOsai', 'galvaCap', 'stenAlumCap', 'stenOsai', 'stenBack', 'goldSten',
])

function ChannelGrid({ diff, itemByPath, decisions, onToggleCell }) {
    // 컬럼: needsLang true 면 영/한 두 컬럼
    const columns = []
    for (const key of CHANNEL_TYPE_ORDER) {
        if (CHANNEL_NEEDS_LANG.has(key)) {
            columns.push({ key, lang: 'eng', label: TYPE_LABELS[key], subLabel: '영' })
            columns.push({ key, lang: 'kor', label: TYPE_LABELS[key], subLabel: '한' })
        } else {
            columns.push({ key, lang: null, label: TYPE_LABELS[key] })
        }
    }

    // 사이즈: diff path 에서 추출
    const sizeSet = new Set()
    for (const it of diff.diffs) {
        const parts = it.path.split('.')
        const size = parts[parts.length - 1]
        if (/^\d+$/.test(size)) sizeSet.add(+size)
    }
    // baseline 사이즈도 일부 포함하면 좋지만 우선 변경 셀이 있는 사이즈만
    const sizes = [...sizeSet].sort((a, b) => a - b)

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head">사이즈</th>
                        {columns.map((c, i) => (
                            <th key={i}>
                                <div>{c.label}</div>
                                {c.subLabel && <small>{c.subLabel}</small>}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sizes.map(size => (
                        <tr key={size}>
                            <td className="qu-grid-row-head">{size}<small>mm</small></td>
                            {columns.map((c, i) => {
                                const path = c.lang
                                    ? `channel.${c.key}.${c.lang}.${size}`
                                    : `channel.${c.key}.${size}`
                                return <DiffCell key={i} item={itemByPath.get(path)} decisions={decisions} onToggleCell={onToggleCell} />
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 고무스카시 표 ---------- */

const GOMU_THICKNESS_ORDER = ['10T', '10T-금은색', '20,30T', '20,30T-금은색', '50T', '50T-금은색']

function GomuGrid({ diff, itemByPath, decisions, onToggleCell }) {
    const bandSet = new Set()
    for (const it of diff.diffs) {
        const parts = it.path.split('.')
        bandSet.add(parts[parts.length - 1])
    }
    const bands = sortBands([...bandSet])

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head">사이즈</th>
                        {GOMU_THICKNESS_ORDER.map(tk => <th key={tk}>{tk}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {GOMU_THICKNESS_ORDER.map(tk => (
                                <DiffCell key={tk} item={itemByPath.get(`gomu.${tk}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 아크릴 표 ---------- */

const ACRYL_THICKNESSES = ['2T', '3T', '5T', '8T', '10T', '15T', '20T']
const ACRYL_TT = ['영문', '한글']

function AcrylGrid({ diff, itemByPath, decisions, onToggleCell }) {
    const bandSet = new Set()
    for (const it of diff.diffs) {
        const parts = it.path.split('.')
        bandSet.add(parts[parts.length - 1])
    }
    const bands = sortBands([...bandSet])

    const columns = []
    for (const tk of ACRYL_THICKNESSES) {
        for (const tt of ACRYL_TT) columns.push({ tk, tt })
    }

    return (
        <div className="qu-grid-scroll">
            <table className="qu-grid">
                <thead>
                    <tr>
                        <th className="qu-grid-row-head" rowSpan={2}>사이즈</th>
                        {ACRYL_THICKNESSES.map(tk => (
                            <th key={tk} colSpan={ACRYL_TT.length} className="qu-grid-group">{tk}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <th key={i}><small>{c.tt}</small></th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {columns.map((c, i) => (
                                <DiffCell key={i} item={itemByPath.get(`acryl.${c.tk}.${c.tt}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ---------- 에폭시 표 ---------- */

const EPOXY_STROKES = ['30', '50', '70', '90', '110']

function EpoxyGrid({ diff, itemByPath, decisions, onToggleCell }) {
    // diff path: epoxy.<mat>.<tt>.<size>.<stroke>
    // 재질·텍스트타입별 sub-table
    const groups = new Map()
    for (const it of diff.diffs) {
        const parts = it.path.split('.')
        const key = `${parts[1]}|${parts[2]}`
        if (!groups.has(key)) groups.set(key, { mat: parts[1], tt: parts[2], sizes: new Set() })
        groups.get(key).sizes.add(parts[3])
    }

    const blocks = []
    for (const { mat, tt, sizes } of groups.values()) {
        const sizeArr = [...sizes].map(Number).sort((a, b) => a - b)
        blocks.push({ mat, tt, sizes: sizeArr })
    }

    if (blocks.length === 0) return <div className="qu-empty">바뀐 곳이 없어요.</div>

    return (
        <div className="qu-epoxy-blocks">
            {blocks.map((blk, i) => (
                <div key={i} className="qu-epoxy-block">
                    <div className="qu-epoxy-block-title">
                        {MAT_LABELS[blk.mat] || blk.mat} · {TT_LABELS[blk.tt] || blk.tt}
                    </div>
                    <div className="qu-grid-scroll">
                        <table className="qu-grid">
                            <thead>
                                <tr>
                                    <th className="qu-grid-row-head">사이즈</th>
                                    {EPOXY_STROKES.map(s => <th key={s}>{s}획</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {blk.sizes.map(size => (
                                    <tr key={size}>
                                        <td className="qu-grid-row-head">~{size}</td>
                                        {EPOXY_STROKES.map(st => (
                                            <DiffCell key={st} item={itemByPath.get(`epoxy.${blk.mat}.${blk.tt}.${size}.${st}`)} decisions={decisions} onToggleCell={onToggleCell} />
                                        ))}
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

/* ---------- 금은경 표 ---------- */

function GoldSilverGrid({ diff, itemByPath, decisions, onToggleCell }) {
    // diff path: goldSilver.<mat>.<tk>.<tt>.<band>
    // 컬럼/밴드 수집
    const bandSet = new Set()
    const colSet = new Map()  // key: mat|tk|tt → {mat, tk, tt}
    for (const it of diff.diffs) {
        const parts = it.path.split('.')
        bandSet.add(parts[4])
        const ckey = `${parts[1]}|${parts[2]}|${parts[3]}`
        if (!colSet.has(ckey)) colSet.set(ckey, { mat: parts[1], tk: parts[2], tt: parts[3] })
    }
    const bands = sortBands([...bandSet])
    const columns = [...colSet.values()].sort((a, b) => {
        if (a.mat !== b.mat) return a.mat === 'gold' ? -1 : 1
        if (a.tk !== b.tk) return a.tk.localeCompare(b.tk)
        return a.tt === '영문' ? -1 : 1
    })

    // material 그룹 헤더
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
                        <th className="qu-grid-row-head" rowSpan={2}>사이즈</th>
                        {matGroups.map((g, i) => (
                            <th key={i} colSpan={g.count} className="qu-grid-group">{MAT_LABELS[g.mat] || g.mat}</th>
                        ))}
                    </tr>
                    <tr>
                        {columns.map((c, i) => (
                            <th key={i}>
                                {c.tk}
                                <small>{TT_LABELS[c.tt] || c.tt}</small>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {bands.map(band => (
                        <tr key={band}>
                            <td className="qu-grid-row-head">{band}</td>
                            {columns.map((c, i) => (
                                <DiffCell key={i} item={itemByPath.get(`goldSilver.${c.mat}.${c.tk}.${c.tt}.${band}`)} decisions={decisions} onToggleCell={onToggleCell} />
                            ))}
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
                            ⚠ 한 번 더 봐줄 셀(0누락/이상치 등) 중 <strong>{suspiciousApplying}곳</strong>이 포함돼 있어요.
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
