/**
 * baseline JSON ↔ 엑셀 파싱 결과 셀 단위 비교.
 *
 * scripts/calc/diff_engine.py 와 동일한 분류·검출 로직을 JS 로 포팅.
 * 브라우저에서 즉시 실행 — 사용자 검토 UI 가 결과를 바로 렌더링.
 */

/* ---------- collectors: 각 계산기 데이터 → 평탄화된 {path: value} ---------- */

function collectChannel(calc) {
    const out = {}
    for (const t of calc.types || []) {
        const tk = t.key
        if (t.needsLang) {
            for (const lang of ['eng', 'kor']) {
                const m = (t.pricesByLang || {})[lang] || {}
                for (const [size, price] of Object.entries(m)) {
                    out[`channel.${tk}.${lang}.${size}`] = price
                }
            }
        } else {
            for (const [size, price] of Object.entries(t.prices || {})) {
                out[`channel.${tk}.${size}`] = price
            }
        }
    }
    return out
}

function collectGomu(calc) {
    const out = {}
    for (const [tk, bands] of Object.entries(calc.prices || {})) {
        for (const [band, price] of Object.entries(bands)) {
            out[`gomu.${tk}.${band}`] = price
        }
    }
    return out
}

function collectAcryl(calc) {
    const out = {}
    for (const [tk, byTt] of Object.entries(calc.prices || {})) {
        for (const [tt, bands] of Object.entries(byTt)) {
            for (const [band, price] of Object.entries(bands)) {
                out[`acryl.${tk}.${tt}.${band}`] = price
            }
        }
    }
    return out
}

function collectEpoxy(calc) {
    const out = {}
    for (const [mat, byTt] of Object.entries(calc.prices || {})) {
        for (const [tt, bySize] of Object.entries(byTt)) {
            for (const [size, byStroke] of Object.entries(bySize)) {
                for (const [stroke, price] of Object.entries(byStroke)) {
                    out[`epoxy.${mat}.${tt}.${size}.${stroke}`] = price
                }
            }
        }
    }
    return out
}

function collectGoldSilver(calc) {
    const out = {}
    for (const [mat, byTk] of Object.entries(calc.prices || {})) {
        for (const [tk, byTt] of Object.entries(byTk)) {
            for (const [tt, byBand] of Object.entries(byTt)) {
                for (const [band, price] of Object.entries(byBand)) {
                    out[`goldSilver.${mat}.${tk}.${tt}.${band}`] = price
                }
            }
        }
    }
    return out
}

const COLLECTORS = {
    channel: collectChannel,
    gomu: collectGomu,
    acryl: collectAcryl,
    epoxy: collectEpoxy,
    goldSilver: collectGoldSilver,
}

/* ---------- suspicion classifier ---------- */

function classifyChange(b, x) {
    if (b === x * 10)  return { suspicion: 'digit_missing', message: `엑셀이 baseline의 1/10 (${x} vs ${b}). 0 누락 가능성 매우 높음.` }
    if (b === x * 100) return { suspicion: 'digit_missing', message: `엑셀이 baseline의 1/100. 0 두 개 누락 가능성.` }
    if (x === b * 10)  return { suspicion: 'extra_digit',   message: `엑셀이 baseline의 10배 (${x} vs ${b}). 0 추가 가능성.` }
    if (x === b * 100) return { suspicion: 'extra_digit',   message: `엑셀이 baseline의 100배. 0 두 개 추가 가능성.` }
    const ratio = b ? x / b : 0
    if (ratio < 0.2) return { suspicion: 'digit_missing', message: `엑셀이 baseline의 ${(ratio * 100).toFixed(0)}%. 자릿수 누락 의심.` }
    if (ratio > 5)   return { suspicion: 'extra_digit',   message: `엑셀이 baseline의 ${ratio.toFixed(1)}배. 과도한 증가.` }
    const deltaPct = b ? ((x - b) / b * 100) : 0
    // 가격 하락은 일반적으로 드물기에 별도 플래그 — 사장님이 의도한 인하인지 확인 필요.
    if (x < b) return { suspicion: 'price_decreased', message: `${deltaPct.toFixed(1)}% 하락 (${b.toLocaleString()} → ${x.toLocaleString()})` }
    return { suspicion: 'clean_change', message: `+${deltaPct.toFixed(1)}% 인상` }
}

/* ---------- monotonicity / spike detection ---------- */

function bandSortKey(band) {
    const cleaned = band.replace(/mm/g, '')
    if (cleaned.startsWith('~')) return parseInt(cleaned.slice(1), 10)
    const m = cleaned.match(/^(\d+)/)
    return m ? parseInt(m[1], 10) : 0
}

function detectMonotonicityBreaks(excelFlat, calcKey) {
    const flagged = new Set()
    const groups = {}

    for (const [path, v] of Object.entries(excelFlat)) {
        const parts = path.split('.')
        let groupKey, sortKey
        if (calcKey === 'channel') {
            if (parts.length === 4) {
                groupKey = `${parts[1]}.${parts[2]}`
                sortKey = parseInt(parts[3], 10)
            } else {
                groupKey = parts[1]
                sortKey = parseInt(parts[2], 10)
            }
        } else if (calcKey === 'gomu' || calcKey === 'acryl') {
            const band = parts[parts.length - 1]
            groupKey = parts.slice(0, -1).join('.')
            sortKey = bandSortKey(band)
        } else if (calcKey === 'epoxy') {
            // epoxy.<mat>.<tt>.<size>.<stroke>: vary size axis per (mat, tt, stroke)
            groupKey = `${parts[1]}.${parts[2]}.${parts[4]}`
            sortKey = parseInt(parts[3], 10)
        } else if (calcKey === 'goldSilver') {
            // goldSilver.<mat>.<tk>.<tt>.<band>: vary band axis
            groupKey = `${parts[1]}.${parts[2]}.${parts[3]}`
            sortKey = bandSortKey(parts[4])
        } else {
            continue
        }
        if (!groups[groupKey]) groups[groupKey] = []
        groups[groupKey].push({ sortKey, path, v })
    }

    for (const items of Object.values(groups)) {
        items.sort((a, b) => a.sortKey - b.sortKey)
        for (let i = 0; i < items.length; i++) {
            const cur = items[i]
            const prev = i > 0 ? items[i - 1] : null
            const next = i < items.length - 1 ? items[i + 1] : null
            if (prev && cur.v < prev.v) flagged.add(cur.path)
            const neighbors = [prev?.v, next?.v].filter(n => n !== undefined && n !== null)
            if (neighbors.length && cur.v > 5 * Math.max(...neighbors)) flagged.add(cur.path)
        }
    }
    return flagged
}

/* ---------- main diff per calculator ---------- */

const SUSPICION_SEVERITY = {
    digit_missing: 'high',
    extra_digit: 'high',
    monotonicity_break: 'medium',
    price_decreased: 'medium',
    clean_change: 'low',
}

function diffCalculator(calcKey, baselineCalc, excelCalc) {
    const collector = COLLECTORS[calcKey]
    if (!collector) return null
    const baseFlat = baselineCalc ? collector(baselineCalc) : {}
    const xlsxFlat = excelCalc ? collector(excelCalc) : {}
    const breaks = detectMonotonicityBreaks(xlsxFlat, calcKey)

    const allPaths = new Set([...Object.keys(baseFlat), ...Object.keys(xlsxFlat)])
    const paths = [...allPaths].sort()

    const counts = { unchanged: 0, changed: 0, missing_in_excel: 0, missing_in_baseline: 0 }
    const suspicionCounts = { digit_missing: 0, extra_digit: 0, monotonicity_break: 0, price_decreased: 0, clean_change: 0 }
    const diffs = []

    for (const path of paths) {
        const b = baseFlat[path]
        const x = xlsxFlat[path]
        if (b === undefined && x === undefined) continue
        if (b === undefined) {
            const isBreak = breaks.has(path)
            diffs.push({
                path, calculator: calcKey,
                baselineValue: null, excelValue: x,
                status: 'missing_in_baseline',
                suspicion: isBreak ? 'monotonicity_break' : null,
                severity: isBreak ? 'medium' : 'info',
                message: isBreak
                    ? '이전 사이즈/밴드보다 가격이 작아짐 — 단조성 위배. 엑셀에만 존재.'
                    : '엑셀에만 존재. baseline에 신규 추가 가능.',
                needsReview: true,
            })
            counts.missing_in_baseline++
            if (isBreak) suspicionCounts.monotonicity_break++
        } else if (x === undefined) {
            diffs.push({
                path, calculator: calcKey,
                baselineValue: b, excelValue: null,
                status: 'missing_in_excel',
                suspicion: null, severity: 'info',
                message: 'baseline에 있지만 엑셀 셀이 비어있음. baseline 값 유지 추천.',
                needsReview: false,
            })
            counts.missing_in_excel++
        } else if (b === x) {
            counts.unchanged++
        } else {
            const { suspicion: rawSusp, message: rawMsg } = classifyChange(b, x)
            let suspicion = rawSusp
            let message = rawMsg
            if (breaks.has(path) && suspicion === 'clean_change') {
                suspicion = 'monotonicity_break'
                message = '이전 사이즈/밴드보다 가격이 작아짐 — 단조성 위배. ' + message
            }
            diffs.push({
                path, calculator: calcKey,
                baselineValue: b, excelValue: x,
                status: 'changed',
                suspicion,
                severity: SUSPICION_SEVERITY[suspicion],
                message,
                needsReview: true,
            })
            counts.changed++
            suspicionCounts[suspicion]++
        }
    }

    return {
        summary: {
            totalBaselineCells: Object.keys(baseFlat).length,
            totalExcelCells: Object.keys(xlsxFlat).length,
            ...counts,
            suspicionBreakdown: suspicionCounts,
        },
        diffs,
    }
}

/* ---------- public API ---------- */

export function computeDiff(baseline, excel) {
    const out = {
        _meta: {
            baselineFrom: baseline._meta?.extractedFrom,
            excelFrom: excel._meta?.extractedFrom,
            engine: 'browser:diffEngine',
            generatedAt: new Date().toISOString(),
        },
        calculators: {},
    }
    for (const calcKey of ['channel', 'gomu', 'acryl', 'epoxy', 'goldSilver']) {
        const result = diffCalculator(
            calcKey,
            baseline.calculators?.[calcKey],
            excel.calculators?.[calcKey],
        )
        if (result) out.calculators[calcKey] = result
    }
    return out
}

/**
 * 사용자 결정({path → 'baseline' | 'excel' | { custom: number }})에 따라
 * 새 prices.json 을 만든다. baseline 을 기반으로 시작하고, 사용자가 'excel' 선택했거나
 * custom 값을 준 셀만 덮어씀.
 *
 * diff (선택): 제공되면 missing_in_excel 셀의 path 를 추출해서, 사용자가 그 셀을
 *   'excel' 로 선택했을 때 baseline 에서 해당 사이즈 키 자체를 삭제한다.
 *   잔넬 단가표가 가격 시프트로 갱신되는 패턴(작은 사이즈 빈칸 + 큰 사이즈 빈칸 채워짐)을
 *   지원하기 위함.
 */
export function buildPricesFromDecisions(baseline, excel, decisions, diff = null) {
    const result = JSON.parse(JSON.stringify(baseline))
    result._meta = {
        ...result._meta,
        version: 'live-prices',
        builtAt: new Date().toISOString(),
        sourceXlsx: excel._meta?.extractedFrom,
    }

    // 빈칸(엑셀에 없음) 셀 path 집합 — 사용자가 'excel' 결정 시 baseline 에서 제거할 대상
    const blankPaths = new Set()
    if (diff) {
        for (const calc of Object.values(diff.calculators || {})) {
            for (const item of calc.diffs || []) {
                if (item.status === 'missing_in_excel') blankPaths.add(item.path)
            }
        }
    }

    for (const [path, decision] of Object.entries(decisions)) {
        if (decision === 'baseline' || decision === null) continue

        if (decision === 'excel' && blankPaths.has(path)) {
            // 사용자가 "엑셀의 빈칸을 그대로 적용" 결정 → baseline 에서 사이즈 키 자체 제거
            removeCellByPath(result, path)
            continue
        }

        const value = decision === 'excel'
            ? getCellByPath(excel, path)
            : (decision && typeof decision === 'object' && 'custom' in decision)
                ? decision.custom
                : null
        if (value === null || value === undefined) continue
        setCellByPath(result, path, value)
    }
    return result
}

function getCellByPath(root, path) {
    const parts = path.split('.')
    const calcKey = parts[0]
    const calc = root.calculators?.[calcKey]
    if (!calc) return null
    if (calcKey === 'channel') {
        const t = (calc.types || []).find(t => t.key === parts[1])
        if (!t) return null
        if (parts.length === 4) return t.pricesByLang?.[parts[2]]?.[parts[3]] ?? null
        return t.prices?.[parts[2]] ?? null
    }
    if (calcKey === 'gomu')   return calc.prices?.[parts[1]]?.[parts[2]] ?? null
    if (calcKey === 'acryl')  return calc.prices?.[parts[1]]?.[parts[2]]?.[parts[3]] ?? null
    if (calcKey === 'epoxy')  return calc.prices?.[parts[1]]?.[parts[2]]?.[parts[3]]?.[parts[4]] ?? null
    if (calcKey === 'goldSilver') return calc.prices?.[parts[1]]?.[parts[2]]?.[parts[3]]?.[parts[4]] ?? null
    return null
}

function removeCellByPath(root, path) {
    const parts = path.split('.')
    const calcKey = parts[0]
    const calc = root.calculators?.[calcKey]
    if (!calc) return
    if (calcKey === 'channel') {
        const t = (calc.types || []).find(t => t.key === parts[1])
        if (!t) return
        if (parts.length === 4) {
            const m = t.pricesByLang?.[parts[2]]
            if (m) delete m[parts[3]]
        } else {
            if (t.prices) delete t.prices[parts[2]]
        }
        return
    }
    if (calcKey === 'gomu') {
        const m = calc.prices?.[parts[1]]
        if (m) delete m[parts[2]]
        return
    }
    if (calcKey === 'acryl') {
        const m = calc.prices?.[parts[1]]?.[parts[2]]
        if (m) delete m[parts[3]]
        return
    }
    if (calcKey === 'epoxy') {
        const m = calc.prices?.[parts[1]]?.[parts[2]]?.[parts[3]]
        if (m) delete m[parts[4]]
        return
    }
    if (calcKey === 'goldSilver') {
        const m = calc.prices?.[parts[1]]?.[parts[2]]?.[parts[3]]
        if (m) delete m[parts[4]]
        return
    }
}

function setCellByPath(root, path, value) {
    const parts = path.split('.')
    const calcKey = parts[0]
    const calc = root.calculators?.[calcKey]
    if (!calc) return
    if (calcKey === 'channel') {
        let t = (calc.types || []).find(t => t.key === parts[1])
        if (!t) {
            t = { key: parts[1], label: parts[1], needsLang: parts.length === 4 }
            if (t.needsLang) t.pricesByLang = { eng: {}, kor: {} }
            else t.prices = {}
            ;(calc.types ||= []).push(t)
        }
        if (parts.length === 4) {
            (t.pricesByLang ||= { eng: {}, kor: {} })
            ;(t.pricesByLang[parts[2]] ||= {})[parts[3]] = value
        } else {
            (t.prices ||= {})[parts[2]] = value
        }
        return
    }
    if (calcKey === 'gomu') {
        ((calc.prices ||= {})[parts[1]] ||= {})[parts[2]] = value
        return
    }
    if (calcKey === 'acryl') {
        const a = (calc.prices ||= {})
        ;(((a[parts[1]] ||= {})[parts[2]] ||= {}))[parts[3]] = value
        return
    }
    if (calcKey === 'epoxy') {
        const a = (calc.prices ||= {})
        ;((((a[parts[1]] ||= {})[parts[2]] ||= {})[parts[3]] ||= {}))[parts[4]] = value
        return
    }
    if (calcKey === 'goldSilver') {
        const a = (calc.prices ||= {})
        ;((((a[parts[1]] ||= {})[parts[2]] ||= {})[parts[3]] ||= {}))[parts[4]] = value
        return
    }
}
