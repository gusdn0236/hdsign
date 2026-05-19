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
    // "영문기본 X" / "한글기본 Y" — 셀이 base group 전체에 적용되는 옛 표기.
    { re: /영문기본\s*([\d,]+)/, lang: 'eng', isBase: true },
    { re: /한글기본\s*([\d,]+)/, lang: 'kor', isBase: true },
    // "영문 X" / "한글 Y" — 해당 사이즈 한 줄에만 적용. 한 셀에 둘 다 있을 수 있어
    //   "영문 53,000\n한글 62,000" 같은 형태도 인식.
    { re: /영문\s+([\d,]+)/,    lang: 'eng', isBase: false },
    { re: /한글\s+([\d,]+)/,    lang: 'kor', isBase: false },
]

/** 한 셀에서 영문/한글 매칭을 모두 추출. lang 당 첫 매칭만 (영문기본 우선). */
function parseChannelTextCell(text) {
    if (typeof text !== 'string') return []
    const flat = text.replace(/\n/g, ' ')
    const byLang = {}
    for (const { re, lang, isBase } of CHANNEL_LANG_PATTERNS) {
        if (byLang[lang]) continue
        const m = flat.match(re)
        if (m) byLang[lang] = { lang, isBase, price: parseInt(m[1].replace(/,/g, ''), 10) }
    }
    return Object.values(byLang)
}

/** 채워진 사이즈들이 모두 같은 값이면, baseGroup 의 빈 사이즈에도 그 값을 복사. */
function backfillBaseGroup(prices, baseGroupSizes) {
    if (!baseGroupSizes || baseGroupSizes.length === 0) return
    const filled = baseGroupSizes.filter(s => prices[s] !== undefined)
    if (filled.length === 0) return
    const firstValue = prices[filled[0]]
    if (!filled.every(s => prices[s] === firstValue)) return
    for (const s of baseGroupSizes) {
        if (prices[s] === undefined) prices[s] = firstValue
    }
}

/**
 * "작은 사이즈" 의 빈 셀은 옛 단가표 표기 방식 (영문기본/한글기본 텍스트 + 빈칸) 으로 인한
 * 표현 한계지 실제 사이즈 제거가 아니다. baseline 값으로 채워서 변경 없는 셀로 처리.
 *
 * "큰 사이즈" (= 채워진 최대 사이즈 이후) 의 빈 셀은 가격 시프트로 실제 사이즈가
 * 제거된 것으로 간주, 빈 상태 유지 → diff 에서 missing_in_excel 로 표시.
 */
function backfillSmallMissing(prices, baselinePrices) {
    if (!baselinePrices) return
    const filledSizes = Object.keys(prices).map(Number)
    if (filledSizes.length === 0) return
    const maxFilled = Math.max(...filledSizes)
    for (const [s, v] of Object.entries(baselinePrices)) {
        if (+s >= maxFilled) continue  // 최대 사이즈 이후는 사이즈 제거로 유지
        if (prices[s] === undefined) prices[s] = v
    }
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
                    const matches = parseChannelTextCell(cell)
                    if (matches.length > 0) {
                        for (const m of matches) {
                            const target = m.lang === 'eng' ? eng : kor
                            if (m.isBase) {
                                // "영문기본 X" — base group 전체에 적용 (옛 형식)
                                for (const bs of baseGroup[m.lang]) target[bs] = m.price
                            } else {
                                // "영문 X" — 해당 사이즈 한 줄에만 적용 (새 형식)
                                target[sizeStr] = m.price
                            }
                        }
                    } else {
                        const n = parseNumber(cell)
                        if (n !== null) {
                            eng[sizeStr] = n
                            kor[sizeStr] = n
                        }
                    }
                }
            }

            // 사후 보강 1: baseGroup 사이즈가 일관되게 채워졌으면 빈 base 사이즈에도 복사.
            backfillBaseGroup(eng, baseGroup.eng)
            backfillBaseGroup(kor, baseGroup.kor)

            // 사후 보강 2: 작은 사이즈 빈 셀은 표기 차이일 뿐이라 baseline 값으로 채움.
            //   최대 채워진 사이즈 이후의 빈 사이즈만 missing_in_excel 로 남겨 "사이즈 제거" 처리.
            backfillSmallMissing(eng, bt.pricesByLang?.eng)
            backfillSmallMissing(kor, bt.pricesByLang?.kor)

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
            // 작은 사이즈 빈 셀은 baseline 값으로 채움 — 최대 사이즈 이후 빈칸만 missing 유지
            backfillSmallMissing(prices, bt.prices)
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

// 카테고리별 시트 이름 키워드. 시트 이름에서 종류 자동 추정에 사용.
const CATEGORY_KEYWORDS = {
    channel:    ['잔넬'],
    gomu:       ['스카시'],
    acryl:      ['아크릴', '포맥스'],
    goldSilver: ['금은경', '금경', '은경'],
    epoxy:      ['에폭시'],
}

const CATEGORY_LABELS = {
    channel:    '잔넬',
    gomu:       '스카시(고무)',
    acryl:      '아크릴/포맥스',
    goldSilver: '금은경',
    epoxy:      '에폭시',
}

const CATEGORY_PARSERS = {
    channel:    parseChannel,
    gomu:       parseGomu,
    acryl:      parseAcryl,
    goldSilver: parseGoldSilver,
    epoxy:      parseEpoxy,
}

function matchesKeywords(name, keywords) {
    const norm = (name || '').trim()
    return keywords.some(kw => norm.includes(kw))
}

/** 시트 이름으로 카테고리 자동 추정 (예: "잔넬26.5인상적용" → 'channel'). 안 맞으면 null. */
export function inferCategoryFromSheetName(name) {
    if (!name) return null
    for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
        if (matchesKeywords(name, kws)) return cat
    }
    return null
}

/**
 * 워크북을 읽어 시트 목록 + 각 시트의 추정 카테고리를 돌려준다.
 *
 * 단가표 파일은 보통 잔넬만 해도 "잔넬24.7인상적용", "잔넬26.5인상적용" 식으로
 * 옛/새 버전이 섞여있어서 — 사용자가 비교 기준 시트 하나를 골라야 함.
 */
export async function inspectXlsx(file) {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheetNames = wb.SheetNames.slice()

    const sheets = sheetNames.map(name => ({
        name,
        inferred: inferCategoryFromSheetName(name),
    }))

    // 디폴트 시트: 가장 마지막 시트 중에 카테고리 추정된 것 (보통 최신 위치).
    let suggested = null
    for (let i = sheets.length - 1; i >= 0; i--) {
        if (sheets[i].inferred) { suggested = sheets[i]; break }
    }
    if (!suggested && sheets.length) suggested = sheets[sheets.length - 1]

    return {
        fileName: file.name,
        buffer: buf,
        sheetNames,
        sheets,
        suggested,
        categories: Object.keys(CATEGORY_KEYWORDS),
        categoryLabels: CATEGORY_LABELS,
    }
}

/**
 * selection 형태별 동작:
 *   • { sheetName, category }  → 그 시트 하나만 해당 카테고리로 파싱 (사용자 선택 모드)
 *   • { channel: '...', gomu: '...', ... } 또는 null
 *                               → legacy: 카테고리별 시트 자동 매칭 (옛 동작)
 *
 * 그 외 카테고리는 calculators 에 들어가지 않으므로 baseline 그대로 유지됨.
 */
export async function parseXlsx(file, baseline, selection = null) {
    const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const bcalc = baseline.calculators
    const calculators = {}

    if (selection && selection.sheetName && selection.category) {
        const parser = CATEGORY_PARSERS[selection.category]
        const ws = wb.Sheets[selection.sheetName]
        if (parser && ws) {
            ws['!sheetName'] = selection.sheetName
            calculators[selection.category] = parser(ws, bcalc[selection.category])
        }
    } else {
        // legacy: 카테고리별 자동 매칭 (sheetMap 객체 또는 null)
        const sheetMap = selection || {}
        for (const [cat, parser] of Object.entries(CATEGORY_PARSERS)) {
            let sheetName = sheetMap[cat] ?? null
            if (!sheetName) {
                sheetName = wb.SheetNames.find(n => matchesKeywords(n, CATEGORY_KEYWORDS[cat])) || null
            }
            if (!sheetName) continue
            const ws = wb.Sheets[sheetName]
            if (!ws) continue
            ws['!sheetName'] = sheetName
            calculators[cat] = parser(ws, bcalc[cat])
        }
    }

    return {
        _meta: {
            version: 'excel-parsed',
            extractedFrom: file?.name || '(buffer)',
            extractedAt: new Date().toISOString(),
            extractor: 'browser:parseXlsx',
            selection: selection || null,
        },
        calculators,
    }
}
