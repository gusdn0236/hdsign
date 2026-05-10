import { useState, useRef, useEffect, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { parseXlsx } from '../../../utils/calc/parseXlsx'
import { computeDiff, buildPricesFromDecisions } from '../../../utils/calc/diffEngine'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

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
    galvaBackEng: '갈바후광 영문',
    galvaBackKor: '갈바후광 한글',
    galvaOsai:    '갈바오사이',
    galvaCap:     '갈바캡잔넬',
    ilcheType:    '일체형',
    takaType:     '타카',
    stenAlumCap:  '스텐알미늄캡',
    stenOsai:     '스텐오사이',
    stenBack:     '스텐후광',
    goldSten:     '골드스텐',
    galvalume:    '갈바',
    stainless:    '스텐',
    korean:       '한글',
    englishNumber:'영문/숫자',
    eng:          '영문',
    kor:          '한글',
    gold:         '금경',
    silver:       '은경',
}

const SUSPICION_META = {
    digit_missing:      { label: '0 누락', tone: 'high' },
    extra_digit:        { label: '0 추가', tone: 'high' },
    monotonicity_break: { label: '이상치',  tone: 'medium' },
    price_decreased:    { label: '가격 하락', tone: 'medium' },
}

/** 경로(channel.galvaOsai.eng.250 등) → 사람이 읽을 수 있는 라벨 */
function humanizePath(path) {
    const parts = path.split('.')
    const root = PATH_LABELS[parts[0]] || parts[0]
    const rest = parts.slice(1).map(p => TYPE_LABELS[p] || p).join(' · ')
    return `${root} · ${rest}`
}

/**
 * 단가표 업로드 + 검증 + 적용.
 *
 * 흐름:
 *  1) idle: 드롭존
 *  2) reviewing: 파싱·diff 후, 의심 셀(가격하락/0누락/이상치/빈칸) 만 보여주고
 *     셀별 [무시 / 적용] 결정. 정상 인상은 자동 반영.
 *  3) applying → done: PUT 후 새 prices 캐시. 최근 1건은 .bak 으로 자동 백업되니
 *     실수해도 백엔드에서 롤백 가능.
 */
export default function QuickUpload() {
    const { token } = useAuth()
    const [baseline, setBaseline] = useState(null)
    const [current, setCurrent] = useState(null)
    const [phase, setPhase] = useState('idle')
    const [parsed, setParsed] = useState(null)
    const [diff, setDiff] = useState(null)
    const [decisions, setDecisions] = useState({})   // suspicious 만 다룸 — apply / skip
    const [errorMsg, setErrorMsg] = useState(null)
    const [dragOver, setDragOver] = useState(false)
    const [fileName, setFileName] = useState(null)
    const fileRef = useRef(null)

    useEffect(() => {
        if (!token) return
        const auth = { Authorization: `Bearer ${token}` }
        Promise.all([
            fetch(`${BASE_URL}/api/admin/calc-prices/baseline`, { headers: auth })
                .then(r => r.ok ? r.json() : Promise.reject(`baseline HTTP ${r.status}`)),
            fetch(`${BASE_URL}/api/admin/calc-prices/current`, { headers: auth })
                .then(r => r.ok ? r.json() : Promise.reject(`current HTTP ${r.status}`)),
        ])
            .then(([b, c]) => { setBaseline(b); setCurrent(c) })
            .catch(e => setErrorMsg(`백엔드 연결 실패: ${e}`))
    }, [token])

    async function handleFile(file) {
        if (!file || !baseline) return
        setPhase('parsing')
        setErrorMsg(null)
        setFileName(file.name)
        try {
            const p = await parseXlsx(file, baseline)
            const d = computeDiff(baseline, p)

            // 의심 셀 = high/medium severity + missing_in_excel(빈칸) — 기본은 모두 'skip'
            const initial = {}
            for (const calc of Object.values(d.calculators)) {
                for (const item of calc.diffs) {
                    if (isSuspicious(item)) initial[item.path] = 'skip'
                }
            }
            setParsed(p)
            setDiff(d)
            setDecisions(initial)
            setPhase('reviewing')
        } catch (err) {
            setPhase('error')
            setErrorMsg(String(err.message || err))
        }
    }

    async function applyAll() {
        if (!diff || !baseline || !parsed) return
        setPhase('applying')
        try {
            // decisions: suspicious 셀만 들어있음. 나머지(정상 인상·신규)는 그냥 excel 적용.
            const finalDecisions = {}
            for (const calc of Object.values(diff.calculators)) {
                for (const item of calc.diffs) {
                    if (isSuspicious(item)) {
                        // 검토 셀 — apply: excel 사용 / skip: baseline 유지
                        finalDecisions[item.path] = decisions[item.path] === 'apply' ? 'excel' : 'baseline'
                    } else {
                        // 정상 — excel 값 우선(없으면 baseline)
                        finalDecisions[item.path] = item.excelValue !== null ? 'excel' : 'baseline'
                    }
                }
            }
            const newPrices = buildPricesFromDecisions(baseline, parsed, finalDecisions)
            const res = await fetch(`${BASE_URL}/api/admin/calc-prices/current`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(newPrices),
            })
            if (!res.ok) throw new Error(`PUT 실패 HTTP ${res.status}`)
            setCurrent(newPrices)
            setPhase('done')
        } catch (err) {
            setPhase('error')
            setErrorMsg(String(err.message || err))
        }
    }

    function reset() {
        setPhase('idle')
        setParsed(null)
        setDiff(null)
        setDecisions({})
        setFileName(null)
        setErrorMsg(null)
    }

    const suspiciousItems = useMemo(() => {
        if (!diff) return []
        const out = []
        for (const calc of Object.values(diff.calculators)) {
            for (const item of calc.diffs) {
                if (isSuspicious(item)) out.push(item)
            }
        }
        // 심각도 순: high → medium → info
        out.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
        return out
    }, [diff])

    const stats = useMemo(() => {
        if (!diff) return null
        let auto = 0, susp = 0, missingExcel = 0, newCells = 0
        for (const calc of Object.values(diff.calculators)) {
            for (const item of calc.diffs) {
                if (item.status === 'changed' && !isSuspicious(item)) auto++
                else if (item.status === 'missing_in_baseline' && !isSuspicious(item)) newCells++
                else if (item.status === 'missing_in_excel') missingExcel++
                if (isSuspicious(item)) susp++
            }
        }
        return { auto, susp, missingExcel, newCells }
    }, [diff])

    const decided = useMemo(
        () => Object.values(decisions).filter(v => v === 'apply' || v === 'skip').length,
        [decisions],
    )

    if (errorMsg && !baseline) {
        return (
            <aside className="qu-card">
                <div className="qu-title">단가표 업로드</div>
                <div className="qu-error-block">
                    <div className="qu-error-title">백엔드 연결 안 됨</div>
                    <div className="qu-error-body">{errorMsg}</div>
                    <div className="qu-error-hint">Railway 백엔드 재배포 후 새로고침</div>
                </div>
            </aside>
        )
    }

    return (
        <aside className="qu-card">
            <div className="qu-title">단가표 업로드</div>
            <div className="qu-sub">
                {phase === 'idle'     && '엑셀 드롭 → 자동 검증'}
                {phase === 'parsing'  && '파싱 중...'}
                {phase === 'reviewing'&& fileName}
                {phase === 'applying' && '저장 중...'}
                {phase === 'done'     && '적용됨'}
                {phase === 'error'    && '오류'}
            </div>

            {phase === 'idle' && (
                <div
                    className={`qu-drop ${dragOver ? 'over' : ''}`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => {
                        e.preventDefault(); setDragOver(false)
                        const f = e.dataTransfer.files?.[0]
                        if (f) handleFile(f)
                    }}
                    onClick={() => fileRef.current?.click()}
                >
                    <div className="qu-drop-icon">↑</div>
                    <div className="qu-drop-text">.xlsx 파일을<br/>끌어다 놓거나 클릭</div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".xlsx,.xlsm"
                        style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                    />
                </div>
            )}

            {phase === 'parsing' && <div className="qu-busy">파싱 중...</div>}

            {phase === 'reviewing' && stats && (
                <>
                    <div className="qu-stats">
                        <div className="qu-stat">
                            <div className="qu-stat-num">{stats.auto + stats.newCells}</div>
                            <div className="qu-stat-label">자동 적용</div>
                        </div>
                        <div className={`qu-stat ${stats.susp > 0 ? 'warn' : ''}`}>
                            <div className="qu-stat-num">{stats.susp}</div>
                            <div className="qu-stat-label">검토 필요</div>
                        </div>
                    </div>

                    {suspiciousItems.length === 0 ? (
                        <div className="qu-clean">
                            의심 셀 없음. 정상 변동만 감지됨.
                        </div>
                    ) : (
                        <div className="qu-review-list">
                            {suspiciousItems.map(item => (
                                <SuspiciousRow
                                    key={item.path}
                                    item={item}
                                    decision={decisions[item.path]}
                                    onDecide={v => setDecisions(d => ({ ...d, [item.path]: v }))}
                                />
                            ))}
                        </div>
                    )}

                    <div className="qu-actions">
                        <button type="button" className="qu-btn-cancel" onClick={reset}>취소</button>
                        <button
                            type="button"
                            className="qu-btn-apply"
                            onClick={applyAll}
                            disabled={suspiciousItems.length > 0 && decided < suspiciousItems.length}
                        >
                            {suspiciousItems.length === 0
                                ? `적용 (${stats.auto + stats.newCells}건)`
                                : `${decided}/${suspiciousItems.length} 결정 후 적용`}
                        </button>
                    </div>
                </>
            )}

            {phase === 'applying' && <div className="qu-busy">저장 중...</div>}

            {phase === 'done' && (
                <div className="qu-done">
                    <div className="qu-check">✓</div>
                    <div className="qu-done-title">적용 완료</div>
                    <div className="qu-done-meta">{new Date().toLocaleTimeString('ko-KR')}<br/>{fileName}</div>
                    <button type="button" className="qu-btn-cancel" onClick={reset} style={{marginTop:12}}>새로 업로드</button>
                </div>
            )}

            {phase === 'error' && (
                <div className="qu-error-block">
                    <div className="qu-error-title">실패</div>
                    <div className="qu-error-body">{errorMsg}</div>
                    <button type="button" className="qu-btn-cancel" onClick={reset} style={{marginTop:8}}>다시 시도</button>
                </div>
            )}

            <div className="qu-current">
                <div className="qu-current-label">현재 단가</div>
                <div className="qu-current-meta">
                    {current?._meta?.builtAt
                        ? `최근 갱신 ${new Date(current._meta.builtAt).toLocaleString('ko-KR')}`
                        : 'baseline 그대로'}
                </div>
            </div>
        </aside>
    )
}


function SuspiciousRow({ item, decision, onDecide }) {
    const meta = SUSPICION_META[item.suspicion] || { label: '확인', tone: 'medium' }
    const isMissingExcel = item.status === 'missing_in_excel'
    return (
        <div className={`qu-row tone-${meta.tone}`}>
            <div className="qu-row-head">
                <span className={`qu-tag tone-${meta.tone}`}>{meta.label}</span>
                <span className="qu-row-path">{humanizePath(item.path)}</span>
            </div>
            <div className="qu-row-vals">
                <span className="qu-val">
                    <small>현재</small>
                    <strong>{item.baselineValue?.toLocaleString() ?? '—'}</strong>
                </span>
                <span className="qu-arrow">→</span>
                <span className="qu-val">
                    <small>엑셀</small>
                    <strong>{item.excelValue?.toLocaleString() ?? '(빈칸)'}</strong>
                </span>
            </div>
            <div className="qu-row-msg">{item.message}</div>
            {!isMissingExcel ? (
                <div className="qu-row-actions">
                    <button
                        type="button"
                        className={`qu-mini ${decision === 'skip' ? 'on' : ''}`}
                        onClick={() => onDecide('skip')}
                    >현재 유지</button>
                    <button
                        type="button"
                        className={`qu-mini ${decision === 'apply' ? 'on' : ''}`}
                        onClick={() => onDecide('apply')}
                    >엑셀 적용</button>
                </div>
            ) : (
                <div className="qu-row-actions single">
                    <button
                        type="button"
                        className={`qu-mini on full`}
                        onClick={() => onDecide('skip')}
                    >빈칸 — 현재값 유지</button>
                </div>
            )}
        </div>
    )
}


function isSuspicious(item) {
    if (item.severity === 'high' || item.severity === 'medium') return true
    if (item.status === 'missing_in_excel') return true   // 빈 셀도 확인 대상
    return false
}

function severityWeight(s) {
    return s === 'high' ? 3 : s === 'medium' ? 2 : s === 'info' ? 1 : 0
}
