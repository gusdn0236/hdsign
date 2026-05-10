/**
 * 잔넬스카시단가표.xlsx → JSON (baseline 과 동일 shape).
 *
 * scripts/calc/parse_excel.py 와 동일한 로직을 SheetJS 기반으로 포팅.
 * 브라우저에서 admin 이 업로드한 파일을 즉시 파싱 — 백엔드 API 호출 없이 클라이언트에서 완료.
 */
import * as XLSX from 'xlsx'

/* ---------- helpers ---------- */

function expandMerges(ws) {
    const ref = ws['!ref']
    if (!ref) return new Map()
    const range = XLSX.utils.decode_range(ref)
    const grid = new Map()
    for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            const addr = XLSX.utils.encode_cell({ r, c })
            const cell = ws[addr]
            grid.set(`${r},${c}`, cell ? cell.v : null)
        }
    }
    const merges = ws['!merges'] || []
    for (const m of merges) {
        const tlAddr = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })
        const tlVal = ws[tlAddr] ? ws[tlAddr].v : null
        for (let r = m.s.r; r <= m.e.r; r++) {
            for (let c = m.s.c; c <= m.e.c; c++) {
                grid.set(`${r},${c}`, tlVal)
            }
        }
    }
    return grid
}

function getCell(grid, row1, col1) {
    // row1/col1 are 1-indexed; SheetJS uses 0-indexed → translate
    return grid.get(`${row1 - 1},${col1 - 1}`)
}

function parseNumber(v) {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return Math.round(v)
    if (typeof v === 'string') {
        const s = v.replace(/,/g, '').replace(/\n/g, '').replace(/\s/g, '')
        if (!s) return null
        const m = s.match(/\d{3,}/)
        if (m) return parseInt(m[0], 10)
    }
    return null
}

const CHANNEL_LANG_PATTERNS = [
    { re: /영문기본\s*([\d,]+)/, lang: 'eng' },
    { re: /한글기본\s*([\d,]+)/, lang: 'kor' },
    { re: /영문\s+([\d,]+)/,    lang: 'eng' },
    { re: /한글\s+([\d,]+)/,    lang: 'kor' },
]

function parseChannelTextCell(text) {
    if (typeof text !== 'string') return null
    const flat = text.replace(/\n/g, ' ')
    for (const { re, lang } of CHANNEL_LANG_PATTERNS) {
        const m = flat.match(re)
        if (m) return { lang, price: parseInt(m[1].replace(/,/g, ''), 10) }
    }
    return null
}

function findBaseGroup(prices) {
    if (!prices || Object.keys(prices).length === 0) return []
    const sizes = Object.keys(prices).sort((a, b) => +a - +b)
    const basePrice = prices[sizes[0]]
    const out = []
    for (const s of sizes) {
        if (prices[s] === basePrice) out.push(s)
        else break
    }
    return out
}

/* ---------- Sheet 0: 잔넬 ---------- */

const CHANNEL_COL_TYPES = [
    [2,  'galvaBackEng', '갈바후광영문'],
    [3,  'galvaBackKor', '갈바후광한글'],
    [4,  'galvaOsai',    '갈바오사이'],
    [5,  'galvaCap',     '갈바캡잔넬'],
    [6,  'ilcheType',    '일체형잔넬'],
    [7,  'takaType',     '타카잔넬'],
    [8,  'stenAlumCap',  '스텐알미늄캡'],
    [9,  'stenOsai',     '스텐오사이'],
    [10, 'stenBack',     '스텐후광'],
    [11, 'goldSten',     '골드스텐'],
]
const CHANNEL_DATA_ROWS = Array.from({ length: 27 }, (_, i) => i + 3) // R03..R29

function parseChannel(ws, baselineChannel) {
    const grid = expandMerges(ws)
    const baseTypeMap = Object.fromEntries(baselineChannel.types.map(t => [t.key, t]))

    const types = []
    for (const [col, key, label] of CHANNEL_COL_TYPES) {
        const bt = baseTypeMap[key]
        const needsLang = bt.needsLang

        if (needsLang) {
            const baseGroup = {
                eng: findBaseGroup(bt.pricesByLang.eng),
                kor: findBaseGroup(bt.pricesByLang.kor),
            }
            const eng = {}
            const kor = {}

            for (const r of CHANNEL_DATA_ROWS) {
                const sizeCm = getCell(grid, r, 1)
                if (typeof sizeCm !== 'number') continue
                const sizeStr = String(sizeCm * 10)
                const cell = getCell(grid, r, col)
                if (cell === null || cell === undefined || cell === '') continue

                if (typeof cell === 'number') {
                    eng[sizeStr] = Math.round(cell)
                    kor[sizeStr] = Math.round(cell)
                    continue
                }
                if (typeof cell === 'string') {
                    const parsed = parseChannelTextCell(cell)
                    if (parsed) {
                        const target = parsed.lang === 'eng' ? eng : kor
                        for (const bs of baseGroup[parsed.lang]) target[bs] = parsed.price
                    } else {
                        const n = parseNumber(cell)
                        if (n !== null) {
                            eng[sizeStr] = n
                            kor[sizeStr] = n
                        }
                    }
                }
            }

            const sortMap = m => Object.fromEntries(
                Object.entries(m).sort(([a], [b]) => +a - +b)
            )

            types.push({
                key, label, needsLang: true,
                pricesByLang: { kor: sortMap(kor), eng: sortMap(eng) },
            })
        } else {
            const prices = {}
            for (const r of CHANNEL_DATA_ROWS) {
                const sizeCm = getCell(grid, r, 1)
                if (typeof sizeCm !== 'number') continue
                const n = parseNumber(getCell(grid, r, col))
                if (n !== null) prices[String(sizeCm * 10)] = n
            }
            types.push({ key, label, needsLang: false, prices })
        }
    }

    return {
        label: baselineChannel.label,
        sheetName: ws['!sheetName'] || '',
        sizeAxis: baselineChannel.sizeAxis,
        types,
    }
}

/* ---------- Sheet 1: 스카시 → gomu ---------- */

const GOMU_COL_THICKNESS = [
    [2, '10T'], [3, '10T-금은색'], [4, '20,30T'],
    [5, '20,30T-금은색'], [6, '50T'], [7, '50T-금은색'],
]

function gomuBandForSize(mm) {
    if (mm <= 149) return '~149'
    if (mm <= 999) {
        const rowIdx = Math.floor((mm - 150) / 50) + 1
        const low = 150 + (rowIdx - 1) * 50
        return `${low}~${low + 49}`
    }
    const rowIdx = 18 + Math.floor((mm - 1000) / 100)
    const low = 1000 + (rowIdx - 18) * 100
    return `${low}~${low + 99}`
}

function parseGomu(ws, baselineGomu) {
    const grid = expandMerges(ws)
    const structured = Object.fromEntries(GOMU_COL_THICKNESS.map(([, tk]) => [tk, {}]))

    for (let r = 4; r <= 32; r++) {
        const sizeCm = getCell(grid, r, 1)
        if (typeof sizeCm !== 'number') continue
        const band = gomuBandForSize(sizeCm * 10)
        for (const [col, tk] of GOMU_COL_THICKNESS) {
            const n = parseNumber(getCell(grid, r, col))
            if (n !== null) structured[tk][band] = n
        }
    }

    return {
        label: baselineGomu.label,
        sheetName: ws['!sheetName'] || '',
        axes: baselineGomu.axes,
        prices: structured,
    }
}

/* ---------- Sheet 2: 아크릴.포맥스 → acryl ---------- */

const ACRYL_THICKNESSES = ['2T', '3T', '5T', '8T', '10T', '15T', '20T']
const ACRYL_TEXT_TYPES = ['영문', '한글']
const BAND_RE = /^(~\d+|\d+~\d+|\d+)$/

function normalizeBandLabel(s) {
    if (typeof s !== 'string') return null
    const cleaned = s.trim().replace(/mm/g, '').replace(/\s/g, '').replace(/-/g, '~')
    if (!cleaned || !BAND_RE.test(cleaned)) return null
    return cleaned
}

function parseAcryl(ws, baselineAcryl) {
    const grid = expandMerges(ws)
    const structured = Object.fromEntries(
        ACRYL_THICKNESSES.map(tk => [tk, Object.fromEntries(ACRYL_TEXT_TYPES.map(tt => [tt, {}]))])
    )

    const ref = XLSX.utils.decode_range(ws['!ref'])
    const maxRow1 = ref.e.r + 1

    for (let r = 5; r <= maxRow1; r++) {
        const band = normalizeBandLabel(getCell(grid, r, 1))
        if (!band) continue
        for (let ti = 0; ti < ACRYL_THICKNESSES.length; ti++) {
            for (let tti = 0; tti < ACRYL_TEXT_TYPES.length; tti++) {
                const col = 2 + ti * 2 + tti
                const n = parseNumber(getCell(grid, r, col))
                if (n !== null) structured[ACRYL_THICKNESSES[ti]][ACRYL_TEXT_TYPES[tti]][band] = n
            }
        }
    }

    return {
        label: baselineAcryl.label,
        sheetName: ws['!sheetName'] || '',
        axes: baselineAcryl.axes,
        prices: structured,
    }
}

/* ---------- Sheet 3: 금은경 → goldSilver ---------- */

const GOLD_SILVER_COLUMNS = [
    [2,  'gold',   '2T',  '영문'], [3,  'gold',   '2T',  '한글'],
    [4,  'gold',   '3T',  '영문'], [5,  'gold',   '3T',  '한글'],
    [6,  'gold',   '5T',  '영문'], [7,  'gold',   '5T',  '한글'],
    [8,  'gold',   '8T',  '영문'], [9,  'gold',   '8T',  '한글'],
    [10, 'gold',   '10T', '영문'],
    [11, 'silver', '8T',  '영문'], [12, 'silver', '8T',  '한글'],
    [13, 'silver', '10T', '영문'], [14, 'silver', '10T', '한글'],
    [15, 'silver', '15T', '영문'], [16, 'silver', '15T', '한글'],
    [17, 'silver', '20T', '영문'], [18, 'silver', '20T', '한글'],
]

function parseGoldSilver(ws, baselineGoldSilver) {
    const grid = expandMerges(ws)
    const structured = { gold: {}, silver: {} }
    const bandsSeen = []

    const ref = XLSX.utils.decode_range(ws['!ref'])
    const maxRow1 = ref.e.r + 1

    for (let r = 4; r <= maxRow1; r++) {
        const band = normalizeBandLabel(getCell(grid, r, 1))
        if (!band) continue
        bandsSeen.push(band)
        for (const [col, mat, tk, tt] of GOLD_SILVER_COLUMNS) {
            const n = parseNumber(getCell(grid, r, col))
            if (n === null) continue
            if (!structured[mat][tk]) structured[mat][tk] = {}
            if (!structured[mat][tk][tt]) structured[mat][tk][tt] = {}
            structured[mat][tk][tt][band] = n
        }
    }

    return {
        label: baselineGoldSilver.label,
        sheetName: ws['!sheetName'] || '',
        axes: { ...baselineGoldSilver.axes, heightBands: bandsSeen },
        prices: structured,
    }
}

/* ---------- Sheet 4: 에폭시 → epoxy ---------- */

const EPOXY_STROKES = [30, 50, 70, 90, 110]
const EPOXY_TEXTTYPE_KEY = {
    '한글': 'korean',
    '영문숫자': 'englishNumber',
    '영문/숫자': 'englishNumber',
    '영문 숫자': 'englishNumber',
}

function parseEpoxy(ws, baselineEpoxy) {
    const grid = expandMerges(ws)
    const structured = {
        galvalume: { korean: {}, englishNumber: {} },
        stainless: { korean: {}, englishNumber: {} },
    }

    // Two side-by-side sections: 갈바 (cols 1-7), 스텐 (cols 9-15)
    const sections = [
        { material: 'galvalume', sizeCol: 1,  ttCol: 2,  priceStartCol: 3 },
        { material: 'stainless', sizeCol: 9,  ttCol: 10, priceStartCol: 11 },
    ]

    const ref = XLSX.utils.decode_range(ws['!ref'])
    const maxRow1 = ref.e.r + 1

    for (let r = 5; r <= maxRow1; r++) {
        for (const { material, sizeCol, ttCol, priceStartCol } of sections) {
            const band = normalizeBandLabel(getCell(grid, r, sizeCol))
            if (!band || !band.startsWith('~')) continue
            const sizeMm = parseInt(band.replace(/^~/, ''), 10)
            if (Number.isNaN(sizeMm)) continue

            const ttRaw = getCell(grid, r, ttCol)
            if (typeof ttRaw !== 'string') continue
            const ttKey = EPOXY_TEXTTYPE_KEY[ttRaw.trim()]
            if (!ttKey) continue

            for (let i = 0; i < EPOXY_STROKES.length; i++) {
                const n = parseNumber(getCell(grid, r, priceStartCol + i))
                if (n === null) continue
                if (!structured[material][ttKey][String(sizeMm)]) {
                    structured[material][ttKey][String(sizeMm)] = {}
                }
                structured[material][ttKey][String(sizeMm)][String(EPOXY_STROKES[i])] = n
            }
        }
    }

    return {
        label: baselineEpoxy.label,
        sheetName: ws['!sheetName'] || '',
        axes: baselineEpoxy.axes,
        prices: structured,
    }
}

/* ---------- main ---------- */

function findSheet(wb, ...keywords) {
    for (const name of wb.SheetNames) {
        const norm = name.trim()
        for (const kw of keywords) {
            if (norm.includes(kw)) return { ws: wb.Sheets[name], title: norm }
        }
    }
    return null
}

export async function parseXlsx(file, baseline) {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })

    const calculators = {}
    const bcalc = baseline.calculators

    const ch = findSheet(wb, '잔넬')
    if (ch) {
        ch.ws['!sheetName'] = ch.title
        calculators.channel = parseChannel(ch.ws, bcalc.channel)
    }

    const go = findSheet(wb, '스카시')
    if (go) {
        go.ws['!sheetName'] = go.title
        calculators.gomu = parseGomu(go.ws, bcalc.gomu)
    }

    const ac = findSheet(wb, '아크릴')
    if (ac) {
        ac.ws['!sheetName'] = ac.title
        calculators.acryl = parseAcryl(ac.ws, bcalc.acryl)
    }

    const gs = findSheet(wb, '금은경', '금경', '은경')
    if (gs) {
        gs.ws['!sheetName'] = gs.title
        calculators.goldSilver = parseGoldSilver(gs.ws, bcalc.goldSilver)
    }

    const ep = findSheet(wb, '에폭시')
    if (ep) {
        ep.ws['!sheetName'] = ep.title
        calculators.epoxy = parseEpoxy(ep.ws, bcalc.epoxy)
    }

    return {
        _meta: {
            version: 'excel-parsed',
            extractedFrom: file.name,
            extractedAt: new Date().toISOString(),
            extractor: 'browser:parseXlsx',
        },
        calculators,
    }
}
