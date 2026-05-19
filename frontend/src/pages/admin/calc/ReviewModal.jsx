import { useEffect, useMemo, useState } from 'react'

const PATH_LABELS = {
    channel:    '잔넬',
    led:        'LED',
    frame:      '후렘',
    epoxy:      '에폭시',
    acryl:      '아크릴',
    gomu:       '고무',
    goldSilver: '금은경',
}

const TYPE_LABELS = {
    galvaBackEng: '갈바후광 영문', galvaBackKor: '갈바후광 한글',
    galvaOsai: '갈바오사이',        galvaCap: '갈바캡잔넬',
    ilcheType: '일체형',            takaType: '타카',
    stenAlumCap: '스텐알미늄캡',    stenOsai: '스텐오사이',
    stenBack: '스텐후광',           goldSten: '골드스텐',
    galvalume: '갈바',              stainless: '스텐',
    korean: '한글',                 englishNumber: '영문/숫자',
    eng: '영문',                    kor: '한글',
    gold: '금경',                   silver: '은경',
}

const SUSPICION_META = {
    digit_missing:      { label: '0 누락',   tone: 'high' },
    extra_digit:        { label: '0 추가',   tone: 'high' },
    monotonicity_break: { label: '이상치',   tone: 'medium' },
    price_decreased:    { label: '가격 하락', tone: 'medium' },
    clean_change:       { label: '인상',     tone: 'ok' },
}

function humanizePath(path) {
    const parts = path.split('.')
    const root = PATH_LABELS[parts[0]] || parts[0]
    const rest = parts.slice(1).map(p => TYPE_LABELS[p] || p).join(' · ')
    return `${root} · ${rest}`
}

function isSuspicious(item) {
    return item.severity === 'high' || item.severity === 'medium'
}

function severityWeight(s) {
    return s === 'high' ? 3 : s === 'medium' ? 2 : s === 'info' ? 1 : 0
}

function formatDelta(b, x) {
    if (b == null || x == null) return null
    const diff = x - b
    const pct = b ? ((x - b) / b) * 100 : 0
    return { diff, pct }
}

/**
 * 변경점 검토 모달.
 *
 * 모든 변경 셀(정상 인상 + 의심 + 신규 + 빈칸)을 표로 보여주고,
 * 사용자가 행별로 [엑셀 적용 / 현재 유지] 결정.
 *
 * 기본값:
 *  - 정상 인상(clean_change)  : 엑셀 적용 (ON)
 *  - 의심 셀 (high / medium)  : 현재 유지 (OFF)
 *  - 신규(missing_in_baseline) clean: 엑셀 적용 (ON), 이상치: OFF
 *  - 빈칸(missing_in_excel)  : 항상 현재 유지 (체크 불가)
 *
 * 적용 클릭 → 확인 다이얼로그 한번 더 → onApply(decisions).
 */
export default function ReviewModal({ diff, fileName, onCancel, onApply }) {
    const allChanges = useMemo(() => {
        if (!diff) return []
        const out = []
        for (const [calcKey, calc] of Object.entries(diff.calculators)) {
            for (const item of calc.diffs) {
                // unchanged 는 출력 안 함 — 변경 없음
                out.push({ ...item, calcKey })
            }
        }
        return out
    }, [diff])

    const initialDecisions = useMemo(() => {
        const d = {}
        for (const item of allChanges) {
            if (item.status === 'missing_in_excel') {
                d[item.path] = 'baseline'             // 빈칸 → 항상 baseline
            } else if (isSuspicious(item)) {
                d[item.path] = 'baseline'             // 의심 → 기본 OFF
            } else {
                d[item.path] = 'excel'                // 정상 → 기본 ON
            }
        }
        return d
    }, [allChanges])

    const [decisions, setDecisions] = useState(initialDecisions)
    const [categoryFilter, setCategoryFilter] = useState('all')      // 'all' | calcKey
    const [reviewOnly, setReviewOnly] = useState(false)
    const [query, setQuery] = useState('')
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

    // 카테고리별 카운트 (탭 배지)
    const catCounts = useMemo(() => {
        const c = { all: allChanges.length }
        for (const item of allChanges) c[item.calcKey] = (c[item.calcKey] || 0) + 1
        return c
    }, [allChanges])

    const filteredChanges = useMemo(() => {
        let arr = allChanges
        if (categoryFilter !== 'all') arr = arr.filter(it => it.calcKey === categoryFilter)
        if (reviewOnly) arr = arr.filter(it => isSuspicious(it) || it.status === 'missing_in_excel')
        if (query.trim()) {
            const q = query.trim().toLowerCase()
            arr = arr.filter(it => humanizePath(it.path).toLowerCase().includes(q) || it.path.toLowerCase().includes(q))
        }
        // 의심 셀 먼저, 그 다음 정렬은 path 기준
        const sorted = arr.slice().sort((a, b) => {
            const sa = severityWeight(a.severity)
            const sb = severityWeight(b.severity)
            if (sa !== sb) return sb - sa
            return a.path.localeCompare(b.path)
        })
        return sorted
    }, [allChanges, categoryFilter, reviewOnly, query])

    // 통계 — 전체 기준
    const stats = useMemo(() => {
        let toApply = 0, toKeep = 0, suspicious = 0, newCells = 0, blankCells = 0
        for (const item of allChanges) {
            if (item.status === 'missing_in_excel') blankCells++
            if (item.status === 'missing_in_baseline') newCells++
            if (isSuspicious(item)) suspicious++
            const d = decisions[item.path]
            if (d === 'excel') toApply++
            else toKeep++
        }
        return { toApply, toKeep, suspicious, newCells, blankCells, total: allChanges.length }
    }, [allChanges, decisions])

    // 현재 필터에 보이는 것들의 선택 상태 (전체 선택 토글에 사용)
    const filterSelection = useMemo(() => {
        let on = 0, off = 0, blockable = 0
        for (const it of filteredChanges) {
            if (it.status === 'missing_in_excel') continue       // 토글 대상 아님
            blockable++
            if (decisions[it.path] === 'excel') on++
            else off++
        }
        return { on, off, blockable, allOn: blockable > 0 && on === blockable, allOff: on === 0 }
    }, [filteredChanges, decisions])

    function setDecision(path, value) {
        setDecisions(d => ({ ...d, [path]: value }))
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

    function handleApplyClick() {
        setConfirming(true)
    }

    function handleConfirmApply() {
        onApply(decisions)
    }

    return (
        <div className="qu-modal-backdrop">
            <div className="qu-modal qu-modal-lg" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">단계 2 / 2 · 바뀐 곳 확인</div>
                        <h2 className="qu-modal-title">{fileName}</h2>
                        <div className="qu-modal-sub">
                            바뀐 항목 <strong>{stats.total}</strong>건 중 <strong>{stats.toApply}</strong>건을 새 단가로 바꾸고, {stats.toKeep}건은 그대로 유지할 거예요.
                            {stats.suspicious > 0 && <> · <span className="qu-text-warn">⚠ 한 번 더 봐줄 항목 {stats.suspicious}건</span></>}
                            {stats.blankCells > 0 && <> · 엑셀에 빈칸 {stats.blankCells}건</>}
                        </div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onCancel} aria-label="닫기">×</button>
                </header>

                <div className="qu-modal-toolbar">
                    <div className="qu-tabs">
                        <button
                            type="button"
                            className={`qu-tab ${categoryFilter === 'all' ? 'active' : ''}`}
                            onClick={() => setCategoryFilter('all')}
                        >전체 <span className="qu-tab-count">{catCounts.all || 0}</span></button>
                        {['channel', 'gomu', 'acryl', 'epoxy', 'goldSilver'].map(c => (
                            catCounts[c] ? (
                                <button
                                    key={c}
                                    type="button"
                                    className={`qu-tab ${categoryFilter === c ? 'active' : ''}`}
                                    onClick={() => setCategoryFilter(c)}
                                >{PATH_LABELS[c]} <span className="qu-tab-count">{catCounts[c]}</span></button>
                            ) : null
                        ))}
                    </div>

                    <div className="qu-toolbar-right">
                        <input
                            type="text"
                            className="qu-search"
                            placeholder="이름으로 찾기 (예: 갈바, 250)"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                        />
                        <label className="qu-toggle">
                            <input
                                type="checkbox"
                                checked={reviewOnly}
                                onChange={e => setReviewOnly(e.target.checked)}
                            />
                            한 번 더 봐줄 항목만 보기
                        </label>
                    </div>
                </div>

                <div className="qu-bulk-bar">
                    <div className="qu-bulk-left">
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            disabled={filterSelection.blockable === 0}
                            onClick={() => bulkSet(filteredChanges, 'excel')}
                        >보이는 항목 전부 체크</button>
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            disabled={filterSelection.blockable === 0}
                            onClick={() => bulkSet(filteredChanges, 'baseline')}
                        >보이는 항목 전부 해제</button>
                        <button
                            type="button"
                            className="qu-bulk-btn"
                            onClick={() => bulkSet(filteredChanges.filter(it => !isSuspicious(it)), 'excel')}
                        >정상 인상만 체크</button>
                    </div>
                    <div className="qu-bulk-right">
                        지금 보이는 <strong>{filteredChanges.length}</strong>건
                        {filterSelection.blockable > 0 && (
                            <> 중 <strong>{filterSelection.on}</strong>건 체크됨</>
                        )}
                    </div>
                </div>

                <div className="qu-modal-body qu-modal-body-table">
                    {filteredChanges.length === 0 ? (
                        <div className="qu-empty">바뀐 곳이 없어요. 다 똑같습니다.</div>
                    ) : (
                        <table className="qu-diff-table">
                            <colgroup>
                                <col style={{ width: 44 }} />
                                <col style={{ width: 100 }} />
                                <col />
                                <col style={{ width: 120 }} />
                                <col style={{ width: 120 }} />
                                <col style={{ width: 110 }} />
                            </colgroup>
                            <thead>
                                <tr>
                                    <th></th>
                                    <th>상태</th>
                                    <th>항목</th>
                                    <th className="num">지금 단가</th>
                                    <th className="num">엑셀 단가</th>
                                    <th className="num">차이</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredChanges.map(item => {
                                    const susp = item.suspicion ? SUSPICION_META[item.suspicion] : null
                                    const tone = susp?.tone || 'neutral'
                                    const isBlank = item.status === 'missing_in_excel'
                                    const isNew = item.status === 'missing_in_baseline'
                                    const checked = decisions[item.path] === 'excel'
                                    const delta = formatDelta(item.baselineValue, item.excelValue)
                                    return (
                                        <tr
                                            key={item.path}
                                            className={`qu-diff-row tone-${tone} ${checked ? 'on' : 'off'} ${isBlank ? 'blank' : ''}`}
                                            onClick={() => !isBlank && setDecision(item.path, checked ? 'baseline' : 'excel')}
                                        >
                                            <td className="qu-diff-check" onClick={e => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    disabled={isBlank}
                                                    onChange={e => setDecision(item.path, e.target.checked ? 'excel' : 'baseline')}
                                                />
                                            </td>
                                            <td>
                                                <div className="qu-diff-tags">
                                                    {susp && <span className={`qu-tag tone-${susp.tone}`}>{susp.label}</span>}
                                                    {isNew && <span className="qu-tag tone-info">신규</span>}
                                                    {isBlank && <span className="qu-tag tone-info">빈칸</span>}
                                                    {!susp && !isNew && !isBlank && <span className="qu-tag tone-ok">정상</span>}
                                                </div>
                                            </td>
                                            <td className="qu-diff-path">
                                                <div className="qu-diff-path-main">{humanizePath(item.path)}</div>
                                                <div className="qu-diff-path-msg">{item.message}</div>
                                            </td>
                                            <td className="num qu-diff-val">
                                                {item.baselineValue != null ? item.baselineValue.toLocaleString() : '—'}
                                            </td>
                                            <td className="num qu-diff-val">
                                                {item.excelValue != null ? item.excelValue.toLocaleString() : <em>(빈칸)</em>}
                                            </td>
                                            <td className="num qu-diff-delta">
                                                {delta ? (
                                                    <span className={delta.diff >= 0 ? 'pos' : 'neg'}>
                                                        {delta.diff >= 0 ? '+' : ''}{delta.diff.toLocaleString()}
                                                        <small>{delta.pct >= 0 ? '+' : ''}{delta.pct.toFixed(1)}%</small>
                                                    </span>
                                                ) : '—'}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>취소하고 처음으로</button>
                    <button
                        type="button"
                        className="qu-btn-apply"
                        onClick={handleApplyClick}
                        disabled={stats.toApply === 0}
                    >
                        {stats.toApply === 0
                            ? '체크된 항목이 없어요'
                            : `체크한 ${stats.toApply}건 단가표에 반영하기`}
                    </button>
                </footer>

                {confirming && (
                    <ConfirmApplyDialog
                        toApply={stats.toApply}
                        toKeep={stats.toKeep}
                        suspiciousApplying={countSuspiciousApplying(allChanges, decisions)}
                        onCancel={() => setConfirming(false)}
                        onConfirm={handleConfirmApply}
                    />
                )}
            </div>
        </div>
    )
}

function countSuspiciousApplying(allChanges, decisions) {
    let n = 0
    for (const it of allChanges) {
        if (isSuspicious(it) && decisions[it.path] === 'excel') n++
    }
    return n
}

function ConfirmApplyDialog({ toApply, toKeep, suspiciousApplying, onCancel, onConfirm }) {
    return (
        <div className="qu-confirm-backdrop" onClick={onCancel}>
            <div className="qu-confirm" onClick={e => e.stopPropagation()}>
                <div className="qu-confirm-title">정말 단가표에 반영할까요?</div>
                <div className="qu-confirm-body">
                    <div className="qu-confirm-line">
                        <strong className="big">{toApply}</strong>건이 엑셀에 적힌 새 단가로 바뀝니다.
                    </div>
                    {toKeep > 0 && (
                        <div className="qu-confirm-line muted">
                            나머지 {toKeep}건은 지금 단가 그대로 유지돼요.
                        </div>
                    )}
                    {suspiciousApplying > 0 && (
                        <div className="qu-confirm-warn">
                            ⚠ 한 번 더 봐줄 항목(0 빠짐·이상치 등) 중 <strong>{suspiciousApplying}건</strong>이 포함돼 있어요.
                            정말 이대로 반영해도 괜찮은지 다시 한 번 확인해주세요.
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
