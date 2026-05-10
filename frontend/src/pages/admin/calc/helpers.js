/**
 * 계산기 공통 유틸: 가격 포맷, 사이즈/밴드 조회, 계산기 메타.
 *
 * 원본 HDCalc.js 의 인덱스/밴드 로직을 baseline JSON 의 axes 에서 구하도록 재작성.
 * "코드와 데이터를 분리" — 이 파일은 데이터 모델만 다룸.
 */

export function formatPrice(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—'
    return Number(n).toLocaleString('ko-KR') + '원'
}

/** 잔넬 사이즈 목록(mm) — baseline.sizeAxis 에서 풀어쓰기. */
export function channelSizes(sizeAxis) {
    if (!sizeAxis) return []
    const out = []
    const { smallStep, largeStep } = sizeAxis
    for (let s = smallStep.from; s <= smallStep.to; s += smallStep.step) out.push(s)
    for (let s = largeStep.from; s <= largeStep.to; s += largeStep.step) out.push(s)
    return out
}

/** 아크릴/금은경 — 사이즈(mm) → baseline 밴드 라벨. */
export function acrylBandForHeight(mm) {
    if (mm <= 30) return '~30'
    const rowIdx = Math.ceil((mm - 30) / 10)
    const low = 31 + (rowIdx - 1) * 10
    return `${low}~${low + 9}`
}

/** 고무스카시 — 사이즈(mm) → baseline 밴드 라벨. */
export function gomuBandForHeight(mm) {
    if (mm <= 149) return '~149'
    if (mm <= 999) {
        const rowIdx = Math.floor((mm - 150) / 50) + 1
        const low = 150 + (rowIdx - 1) * 50
        return `${low}~${low + 49}`
    }
    if (mm > 2000) return null
    const rowIdx = 18 + Math.floor((mm - 1000) / 100)
    const low = 1000 + (rowIdx - 18) * 100
    return `${low}~${low + 99}`
}

/** 금은경 — 사이즈(mm) → 밴드. 가장 작은 첫 밴드는 '~20', 그 이후 21~30, 31~40, ... 10mm 폭. */
export function goldSilverBandForHeight(mm) {
    if (mm <= 20) return '~20'
    const rowIdx = Math.ceil((mm - 20) / 10)
    const low = 21 + (rowIdx - 1) * 10
    return `${low}~${low + 9}`
}

/** 7개 계산기 메타 — sub-nav 와 라우트에 사용. */
export const CALC_META = [
    { key: 'channel',    path: 'channel',    label: '잔넬 단가' },
    { key: 'led',        path: 'led',        label: 'LED 추가' },
    { key: 'frame',      path: 'frame',      label: '후렘 추가' },
    { key: 'epoxy',      path: 'epoxy',      label: '에폭시' },
    { key: 'acryl',      path: 'acryl',      label: '아크릴/포맥스' },
    { key: 'gomu',       path: 'gomu',       label: '고무스카시' },
    { key: 'goldSilver', path: 'gold-silver', label: '금은경' },
]
