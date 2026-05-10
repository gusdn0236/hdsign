import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { parseXlsx } from '../../../utils/calc/parseXlsx'
import { computeDiff, buildPricesFromDecisions } from '../../../utils/calc/diffEngine'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/**
 * 단가표 빠른 적용 — 엑셀 드롭하면 바로 prices.json 에 반영.
 *
 * Phase 6 의 셀별 review 단계는 건너뜀: 원본 엑셀의 모든 값을 그대로 적용.
 * (잘못된 셀이 있으면 git 에서 prices.json diff 확인 후 .bak 으로 롤백 가능.)
 *
 * 변경 요약(증가/신규/유지)만 보여주고 끝. 사용 빈도는 낮지만 흐름은 단순해야.
 */
export default function QuickUpload() {
    const { token } = useAuth()
    const [baseline, setBaseline] = useState(null)
    const [current, setCurrent] = useState(null)
    const [phase, setPhase] = useState('idle')   // idle | parsing | applying | done | error
    const [summary, setSummary] = useState(null)
    const [errorMsg, setErrorMsg] = useState(null)
    const [dragOver, setDragOver] = useState(false)
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
        setSummary(null)
        try {
            const parsed = await parseXlsx(file, baseline)
            const diff = computeDiff(baseline, parsed)

            // 모든 셀에 대해 엑셀 값 사용 (엑셀에 없으면 자동으로 baseline 유지)
            const decisions = {}
            for (const calc of Object.values(diff.calculators)) {
                for (const item of calc.diffs) {
                    decisions[item.path] = item.excelValue !== null ? 'excel' : 'baseline'
                }
            }
            const newPrices = buildPricesFromDecisions(baseline, parsed, decisions)

            setPhase('applying')
            const res = await fetch(`${BASE_URL}/api/admin/calc-prices/current`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(newPrices),
            })
            if (!res.ok) throw new Error(`PUT 실패 HTTP ${res.status}`)

            // 카테고리별 변경 요약
            const cats = {}
            for (const [k, calc] of Object.entries(diff.calculators)) {
                const s = calc.summary
                cats[k] = {
                    changed: s.changed,
                    newCells: s.missing_in_baseline,
                    unchanged: s.unchanged,
                }
            }
            setSummary({ fileName: file.name, cats, at: new Date() })
            setCurrent(newPrices)
            setPhase('done')
        } catch (err) {
            setPhase('error')
            setErrorMsg(String(err.message || err))
        }
    }

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
            <div className="qu-sub">엑셀 드롭 → 즉시 반영</div>

            <div
                className={`qu-drop ${dragOver ? 'over' : ''} ${phase === 'idle' ? '' : 'busy'}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                    e.preventDefault(); setDragOver(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f && phase !== 'parsing' && phase !== 'applying') handleFile(f)
                }}
                onClick={() => phase !== 'parsing' && phase !== 'applying' && fileRef.current?.click()}
            >
                {phase === 'idle' && (
                    <>
                        <div className="qu-drop-icon">↑</div>
                        <div className="qu-drop-text">.xlsx 파일을 끌어다 놓거나<br/>클릭해서 선택</div>
                    </>
                )}
                {phase === 'parsing'  && <div className="qu-drop-text">파싱 중...</div>}
                {phase === 'applying' && <div className="qu-drop-text">저장 중...</div>}
                {phase === 'done' && summary && (
                    <div className="qu-drop-done">
                        <div className="qu-check">✓</div>
                        <div>적용됨</div>
                        <small>{summary.at.toLocaleTimeString('ko-KR')}</small>
                    </div>
                )}
                {phase === 'error' && (
                    <div className="qu-drop-error">
                        <div>실패</div>
                        <small>{errorMsg?.slice(0, 80)}</small>
                    </div>
                )}
                <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xlsm"
                    style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                />
            </div>

            {summary && (
                <div className="qu-summary">
                    <div className="qu-summary-file">{summary.fileName}</div>
                    <table className="qu-summary-table">
                        <thead><tr><th>분류</th><th>변경</th><th>신규</th></tr></thead>
                        <tbody>
                            {Object.entries(summary.cats).map(([k, c]) => {
                                const label = CALC_LABEL[k] || k
                                const total = c.changed + c.newCells
                                if (total === 0) return null
                                return (
                                    <tr key={k}>
                                        <td>{label}</td>
                                        <td className={c.changed ? 'has' : ''}>{c.changed || '·'}</td>
                                        <td className={c.newCells ? 'has' : ''}>{c.newCells || '·'}</td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div className="qu-summary-hint">
                        새 단가가 즉시 적용됨 — 페이지 새로고침 시 반영. 잘못 올렸다면 백엔드 .bak 파일로 롤백 가능.
                    </div>
                </div>
            )}

            <div className="qu-current">
                <div className="qu-current-label">현재 단가 데이터</div>
                <div className="qu-current-meta">
                    {current?._meta?.builtAt
                        ? `최근 갱신 ${new Date(current._meta.builtAt).toLocaleString('ko-KR')}`
                        : 'baseline 그대로 (엑셀 미적용)'}
                </div>
            </div>
        </aside>
    )
}

const CALC_LABEL = {
    channel:    '잔넬',
    gomu:       '고무스카시',
    acryl:      '아크릴',
    epoxy:      '에폭시',
    goldSilver: '금은경',
}
