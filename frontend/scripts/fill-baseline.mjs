/**
 * 옛 단가표(.xlsx) 의 형식을 그대로 두고, 셀 값만 prices_baseline.json 의 값으로
 * 채워서 새 파일로 저장한다. parseXlsx 의 정확한 inverse.
 *
 *   node scripts/fill-baseline.mjs <input.xlsx> [output.xlsx]
 *
 * 위치별 매핑은 src/utils/calc/parseXlsx.js 의 파서들과 동일.
 */
import XLSX from 'xlsx'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const FRONTEND_ROOT = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(FRONTEND_ROOT, 'src', 'data', 'calc', 'prices_baseline.json')

const INPUT  = process.argv[2] || 'C:/Users/USER/Desktop/priceList.xlsx'
const OUTPUT = process.argv[3] || INPUT.replace(/\.xlsx$/i, '_baseline.xlsx')

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
const wb = XLSX.readFile(INPUT)

console.log('Input :', INPUT)
console.log('Output:', OUTPUT)
console.log('Sheets:', wb.SheetNames.map(s => s.trim()).join(', '))

/* ---------- 시트 이름 매칭 (parseXlsx 와 동일) ---------- */

function findSheet(wb, ...keywords) {
    for (const name of wb.SheetNames) {
        const norm = name.trim()
        for (const kw of keywords) if (norm.includes(kw)) return name
    }
    return null
}

/* ---------- 셀 헬퍼 ---------- */

function readCell(ws, row1, col1) {
    const addr = XLSX.utils.encode_cell({ r: row1 - 1, c: col1 - 1 })
    return ws[addr] ? ws[addr].v : null
}

function writeCell(ws, row1, col1, value) {
    const addr = XLSX.utils.encode_cell({ r: row1 - 1, c: col1 - 1 })
    if (value === undefined) return  // 그대로 둠
    if (value === null) {
        if (ws[addr]) delete ws[addr]
        return
    }
    if (typeof value === 'string') ws[addr] = { t: 's', v: value }
    else if (typeof value === 'number') ws[addr] = { t: 'n', v: value }
    // range 도 확장 필요할 수 있지만 기존 단가표는 이미 충분히 넓은 영역
}

function decodeMaxRow(ws) {
    const ref = ws['!ref']
    if (!ref) return 0
    return XLSX.utils.decode_range(ref).e.r + 1
}

const BAND_RE = /^(~\d+|\d+~\d+|\d+)$/
function normalizeBandLabel(s) {
    if (typeof s !== 'string') return null
    const cleaned = s.trim().replace(/mm/g, '').replace(/\s/g, '').replace(/-/g, '~')
    if (!cleaned || !BAND_RE.test(cleaned)) return null
    return cleaned
}

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

/* ---------- 잔넬 ---------- */

const CHANNEL_COL_TYPES = [
    [2,  'galvaBackEng'], [3,  'galvaBackKor'], [4,  'galvaOsai'],
    [5,  'galvaCap'],     [6,  'ilcheType'],    [7,  'takaType'],
    [8,  'stenAlumCap'],  [9,  'stenOsai'],     [10, 'stenBack'], [11, 'goldSten'],
]

function buildChannelTypeCells(t) {
    // 반환: Map<sizeMm, cellValue>
    //   cellValue: number(영/한 동일) | string("영문 X\n한글 Y" — 영/한 다름)
    //
    // baseline 의 모든 (eng, kor) 정보를 손실 없이 표현하기 위해 사이즈 단위로 직접 표기.
    // parseChannel 이 한 셀의 "영문 X / 한글 Y" 두 매칭 모두 인식하도록 확장됨.
    const out = new Map()

    if (!t.needsLang) {
        for (const [s, p] of Object.entries(t.prices || {})) out.set(+s, p)
        return out
    }

    const eng = t.pricesByLang?.eng || {}
    const kor = t.pricesByLang?.kor || {}
    const allSizes = [...new Set([...Object.keys(eng), ...Object.keys(kor)])]
        .map(Number).sort((a, b) => a - b)

    for (const s of allSizes) {
        const e = eng[s]
        const k = kor[s]
        if (e == null && k == null) continue
        if (e == null)      out.set(s, `한글 ${k.toLocaleString()}`)
        else if (k == null) out.set(s, `영문 ${e.toLocaleString()}`)
        else if (e === k)   out.set(s, e)
        else                out.set(s, `영문 ${e.toLocaleString()}\n한글 ${k.toLocaleString()}`)
    }
    return out
}

function fillChannel(ws, calc) {
    const typeByKey = Object.fromEntries((calc.types || []).map(t => [t.key, t]))
    const cellMaps = {}
    for (const [, key] of CHANNEL_COL_TYPES) {
        if (typeByKey[key]) cellMaps[key] = buildChannelTypeCells(typeByKey[key])
    }

    for (let r = 3; r <= 29; r++) {
        const sizeCm = readCell(ws, r, 1)
        if (typeof sizeCm !== 'number') continue
        const sizeMm = sizeCm * 10

        for (const [col, key] of CHANNEL_COL_TYPES) {
            const m = cellMaps[key]
            if (!m) continue
            const v = m.has(sizeMm) ? m.get(sizeMm) : undefined
            writeCell(ws, r, col, v)
        }
    }
}

/* ---------- 스카시 (gomu) ---------- */

const GOMU_COL_THICKNESS = [
    [2, '10T'], [3, '10T-금은색'], [4, '20,30T'],
    [5, '20,30T-금은색'], [6, '50T'], [7, '50T-금은색'],
]

function fillGomu(ws, calc) {
    for (let r = 4; r <= 32; r++) {
        const sizeCm = readCell(ws, r, 1)
        if (typeof sizeCm !== 'number') continue
        const band = gomuBandForSize(sizeCm * 10)

        for (const [col, tk] of GOMU_COL_THICKNESS) {
            const v = calc.prices?.[tk]?.[band]
            writeCell(ws, r, col, v != null ? v : undefined)
        }
    }
}

/* ---------- 아크릴 ---------- */

const ACRYL_THICKNESSES = ['2T', '3T', '5T', '8T', '10T', '15T', '20T']
const ACRYL_TEXT_TYPES = ['영문', '한글']

function fillAcryl(ws, calc) {
    const maxRow = decodeMaxRow(ws)
    for (let r = 5; r <= maxRow; r++) {
        const band = normalizeBandLabel(readCell(ws, r, 1))
        if (!band) continue
        for (let ti = 0; ti < ACRYL_THICKNESSES.length; ti++) {
            for (let tti = 0; tti < ACRYL_TEXT_TYPES.length; tti++) {
                const col = 2 + ti * 2 + tti
                const v = calc.prices?.[ACRYL_THICKNESSES[ti]]?.[ACRYL_TEXT_TYPES[tti]]?.[band]
                writeCell(ws, r, col, v != null ? v : undefined)
            }
        }
    }
}

/* ---------- 금은경 ---------- */

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

function fillGoldSilver(ws, calc) {
    const maxRow = decodeMaxRow(ws)
    for (let r = 4; r <= maxRow; r++) {
        const band = normalizeBandLabel(readCell(ws, r, 1))
        if (!band) continue
        for (const [col, mat, tk, tt] of GOLD_SILVER_COLUMNS) {
            const v = calc.prices?.[mat]?.[tk]?.[tt]?.[band]
            writeCell(ws, r, col, v != null ? v : undefined)
        }
    }
}

/* ---------- 에폭시 ---------- */

const EPOXY_STROKES = [30, 50, 70, 90, 110]
const EPOXY_TEXTTYPE_KEY = {
    '한글': 'korean',
    '영문숫자': 'englishNumber',
    '영문/숫자': 'englishNumber',
    '영문 숫자': 'englishNumber',
}

function fillEpoxy(ws, calc) {
    const sections = [
        { material: 'galvalume', sizeCol: 1,  ttCol: 2,  priceStartCol: 3 },
        { material: 'stainless', sizeCol: 9,  ttCol: 10, priceStartCol: 11 },
    ]
    const maxRow = decodeMaxRow(ws)
    for (let r = 5; r <= maxRow; r++) {
        for (const { material, sizeCol, ttCol, priceStartCol } of sections) {
            const band = normalizeBandLabel(readCell(ws, r, sizeCol))
            if (!band || !band.startsWith('~')) continue
            const sizeMm = parseInt(band.replace(/^~/, ''), 10)
            if (Number.isNaN(sizeMm)) continue

            const ttRaw = readCell(ws, r, ttCol)
            if (typeof ttRaw !== 'string') continue
            const ttKey = EPOXY_TEXTTYPE_KEY[ttRaw.trim()]
            if (!ttKey) continue

            for (let i = 0; i < EPOXY_STROKES.length; i++) {
                const v = calc.prices?.[material]?.[ttKey]?.[String(sizeMm)]?.[String(EPOXY_STROKES[i])]
                writeCell(ws, r, priceStartCol + i, v != null ? v : undefined)
            }
        }
    }
}

/* ---------- main ---------- */

const filled = []
const skipped = []

const channelSheet = findSheet(wb, '잔넬')
if (channelSheet) { fillChannel(wb.Sheets[channelSheet], baseline.calculators.channel); filled.push(`channel → ${channelSheet.trim()}`) }
else skipped.push('channel')

const gomuSheet = findSheet(wb, '스카시')
if (gomuSheet) { fillGomu(wb.Sheets[gomuSheet], baseline.calculators.gomu); filled.push(`gomu → ${gomuSheet.trim()}`) }
else skipped.push('gomu')

const acrylSheet = findSheet(wb, '아크릴', '포맥스')
if (acrylSheet) { fillAcryl(wb.Sheets[acrylSheet], baseline.calculators.acryl); filled.push(`acryl → ${acrylSheet.trim()}`) }
else skipped.push('acryl')

const gsSheet = findSheet(wb, '금은경', '금경', '은경')
if (gsSheet) { fillGoldSilver(wb.Sheets[gsSheet], baseline.calculators.goldSilver); filled.push(`goldSilver → ${gsSheet.trim()}`) }
else skipped.push('goldSilver')

const epoxySheet = findSheet(wb, '에폭시')
if (epoxySheet) { fillEpoxy(wb.Sheets[epoxySheet], baseline.calculators.epoxy); filled.push(`epoxy → ${epoxySheet.trim()}`) }
else skipped.push('epoxy')

console.log('\nFilled:')
filled.forEach(l => console.log('  ✓', l))
if (skipped.length) {
    console.log('\nSkipped (시트 없음):')
    skipped.forEach(l => console.log('  -', l))
}

XLSX.writeFile(wb, OUTPUT)
console.log('\nSaved:', OUTPUT)
