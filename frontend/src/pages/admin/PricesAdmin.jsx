import { useState, useEffect, useMemo, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'
import { parseXlsx } from '../../utils/calc/parseXlsx'
import { computeDiff, buildPricesFromDecisions } from '../../utils/calc/diffEngine'
import './PricesAdmin.css'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

const CALC_LABELS = {
    channel:    '잔넬 단가',
    gomu:       '고무스카시',
    acryl:      '아크릴/포맥스',
    epoxy:      '에폭시 잔넬',
    goldSilver: '금은경 (신규)',
}

const SEVERITY_LABEL = {
    high:   { label: '높음', className: 'sev-high',   help: '0 누락/추가 의심' },
    medium: { label: '중간', className: 'sev-medium', help: '단조성 위배' },
    low:    { label: '낮음', className: 'sev-low',    help: '단순 변동' },
    info:   { label: '정보', className: 'sev-info',   help: '셀 누락' },
}

const STATUS_LABEL = {
    changed:              '변경',
    missing_in_excel:     'baseline에만',
    missing_in_baseline:  '엑셀에만',
}

/** decision: 'baseline' | 'excel' | null  (null = 결정 안 됨) */
function defaultDecision(diff) {
    // 안전 기본값: 모든 셀을 baseline 유지로 시작. 사용자가 명시적으로 'excel' 선택해야 적용.
    return 'baseline'
}

export default function PricesAdmin() {
    const { token } = useAuth()
    const [baseline, setBaseline] = useState(null)
    const [current, setCurrent] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [excel, setExcel] = useState(null)
    const [diff, setDiff] = useState(null)
    const [decisions, setDecisions] = useState({})
    const [activeCalc, setActiveCalc] = useState('channel')
    const [filter, setFilter] = useState('needsReview')   // needsReview | all | high | medium | low
    const [saving, setSaving] = useState(false)
    const [feedback, setFeedback] = useState(null)
    const fileInputRef = useRef(null)

    // baseline + 현재 prices 로드. token 이 아직 안 들어온 시점에 호출하면 무조건 401 이라 token 도착 후에만 시도.
    useEffect(() => {
        if (!token) return
        setLoadError(null)
        const auth = { Authorization: `Bearer ${token}` }
        const fetchJson = (path) => fetch(`${BASE_URL}${path}`, { headers: auth })
            .then(async r => {
                if (r.ok) return r.json()
                const body = await r.text().catch(() => '')
                throw new Error(`${path} → HTTP ${r.status}${body ? ` (${body.slice(0, 120)})` : ''}`)
            })
        Promise.all([
            fetchJson('/api/admin/calc-prices/baseline'),
            fetchJson('/api/admin/calc-prices/current'),
        ]).then(([bl, cur]) => {
            setBaseline(bl)
            setCurrent(cur)
        }).catch(err => setLoadError(String(err.message || err)))
    }, [token])

    async function handleFile(file) {
        if (!file || !baseline) return
        setFeedback(null)
        try {
            const parsed = await parseXlsx(file, baseline)
            const d = computeDiff(baseline, parsed)
            setExcel(parsed)
            setDiff(d)
            // decisions 초기화 — 모든 셀 baseline 유지가 기본
            const initial = {}
            for (const calc of Object.values(d.calculators)) {
                for (const item of calc.diffs) {
                    initial[item.path] = defaultDecision(item)
                }
            }
            setDecisions(initial)
            setActiveCalc(Object.keys(d.calculators)[0] || 'channel')
        } catch (err) {
            setFeedback({ type: 'error', msg: `파싱 실패: ${err.message}` })
        }
    }

    function applyBulk(target) {
        // target: 'baseline' | 'excel'
        if (!diff) return
        const next = { ...decisions }
        for (const item of diff.calculators[activeCalc]?.diffs || []) {
            if (!matchesFilter(item)) continue
            // missing_in_excel은 '엑셀에만' 으로 강제 못 함 (xlsx에 값이 없으니)
            if (target === 'excel' && item.excelValue === null) continue
            next[item.path] = target
        }
        setDecisions(next)
    }

    function matchesFilter(item) {
        if (filter === 'all') return true
        if (filter === 'needsReview') return item.needsReview
        return item.severity === filter
    }

    const visibleItems = useMemo(() => {
        if (!diff || !diff.calculators[activeCalc]) return []
        return diff.calculators[activeCalc].diffs.filter(matchesFilter)
    }, [diff, activeCalc, filter])

    async function handleSave() {
        if (!diff || !baseline) return
        const undecided = Object.entries(decisions).filter(([, v]) => v == null)
        if (undecided.length > 0) {
            setFeedback({ type: 'error', msg: `미결정 ${undecided.length}건 — 모두 결정 후 저장하세요.` })
            return
        }
        if (!window.confirm(`${Object.keys(decisions).length}건의 결정을 prices.json 에 반영합니다. 계속할까요?`)) {
            return
        }
        setSaving(true)
        setFeedback(null)
        try {
            const newPrices = buildPricesFromDecisions(baseline, excel, decisions)
            const res = await fetch(`${BASE_URL}/api/admin/calc-prices/current`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(newPrices),
            })
            if (!res.ok) throw new Error(await res.text())
            const j = await res.json()
            setCurrent(newPrices)
            setFeedback({ type: 'success', msg: `저장 완료 (${j.bytes ?? '?'} bytes). 이전 값은 .bak 으로 보존됨.` })
        } catch (err) {
            setFeedback({ type: 'error', msg: `저장 실패: ${err.message}` })
        } finally {
            setSaving(false)
        }
    }

    if (loadError) {
        return (
            <div className="prices-admin">
                <header className="prices-header"><h2>단가 데이터 관리</h2></header>
                <div className="feedback feedback-error" style={{ marginTop: 12 }}>
                    데이터 로드 실패: {loadError}
                    <br />
                    <small style={{ opacity: 0.8 }}>
                        백엔드(8080) 가 떠있는지, 관리자로 로그인되어 있는지, 데이터 디렉터리(<code>calc.data-dir</code>)에
                        prices_baseline.json 이 있는지 확인하세요.
                    </small>
                </div>
            </div>
        )
    }
    if (!baseline || !current) {
        return <div className="prices-admin"><p>로드 중...</p></div>
    }

    return (
        <div className="prices-admin">
            <header className="prices-header">
                <h2>단가 데이터 관리</h2>
                <p className="prices-subtitle">
                    엑셀 단가표를 업로드해 baseline 과 비교 후 셀 단위로 승인/반려.
                    의심 셀(0 누락·단조성 위배)은 자동으로 표시됩니다.
                </p>
            </header>

            {!diff && (
                <UploadZone
                    onFile={handleFile}
                    fileInputRef={fileInputRef}
                    feedback={feedback}
                />
            )}

            {diff && (
                <ReviewSection
                    diff={diff}
                    activeCalc={activeCalc}
                    setActiveCalc={setActiveCalc}
                    filter={filter}
                    setFilter={setFilter}
                    visibleItems={visibleItems}
                    decisions={decisions}
                    setDecisions={setDecisions}
                    applyBulk={applyBulk}
                    onReset={() => { setDiff(null); setExcel(null); setDecisions({}) }}
                    onSave={handleSave}
                    saving={saving}
                    feedback={feedback}
                />
            )}
        </div>
    )
}

function UploadZone({ onFile, fileInputRef, feedback }) {
    const [dragOver, setDragOver] = useState(false)

    function handleDrop(e) {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) onFile(file)
    }

    return (
        <div className="upload-section">
            <div
                className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <p className="drop-zone-title">엑셀 파일을 끌어다 놓거나 클릭해서 선택</p>
                <p className="drop-zone-hint">잔넬·스카시·아크릴·금은경·에폭시 5개 시트가 있는 xlsx</p>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xlsm"
                    style={{ display: 'none' }}
                    onChange={e => onFile(e.target.files?.[0])}
                />
            </div>
            {feedback && (
                <div className={`feedback feedback-${feedback.type}`}>{feedback.msg}</div>
            )}
        </div>
    )
}

function ReviewSection({
    diff, activeCalc, setActiveCalc, filter, setFilter,
    visibleItems, decisions, setDecisions, applyBulk,
    onReset, onSave, saving, feedback,
}) {
    const calcKeys = Object.keys(diff.calculators)
    const summary = diff.calculators[activeCalc]?.summary
    const totalReview = Object.values(decisions).length
    const decidedCount = Object.values(decisions).filter(v => v != null).length

    return (
        <div className="review-section">
            <div className="review-toolbar">
                <button type="button" className="btn-link" onClick={onReset}>← 다른 파일 업로드</button>
                <div className="progress-info">
                    검토 진행: <strong>{decidedCount}</strong> / {totalReview}
                </div>
            </div>

            <div className="calc-tabs">
                {calcKeys.map(k => {
                    const s = diff.calculators[k].summary
                    const review = (s.changed || 0) + (s.missing_in_baseline || 0)
                    return (
                        <button
                            key={k}
                            type="button"
                            className={`calc-tab ${k === activeCalc ? 'active' : ''}`}
                            onClick={() => setActiveCalc(k)}
                        >
                            <span className="tab-label">{CALC_LABELS[k]}</span>
                            <span className={`tab-badge ${review > 0 ? 'has-review' : ''}`}>
                                {review > 0 ? `${review}건 검토` : '일치'}
                            </span>
                        </button>
                    )
                })}
            </div>

            {summary && <SummaryStats summary={summary} />}

            <div className="filter-bar">
                <div className="filter-group">
                    <span className="filter-label">필터:</span>
                    {[
                        ['needsReview', `검토 필요 (${diff.calculators[activeCalc].diffs.filter(d => d.needsReview).length})`],
                        ['high',        `높음 (${diff.calculators[activeCalc].diffs.filter(d => d.severity === 'high').length})`],
                        ['medium',      `중간 (${diff.calculators[activeCalc].diffs.filter(d => d.severity === 'medium').length})`],
                        ['low',         `낮음 (${diff.calculators[activeCalc].diffs.filter(d => d.severity === 'low').length})`],
                        ['all',         `전체 (${diff.calculators[activeCalc].diffs.length})`],
                    ].map(([k, label]) => (
                        <button
                            key={k}
                            type="button"
                            className={`filter-btn ${filter === k ? 'active' : ''}`}
                            onClick={() => setFilter(k)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div className="bulk-group">
                    <span className="filter-label">일괄:</span>
                    <button type="button" className="bulk-btn" onClick={() => applyBulk('baseline')}>
                        모두 baseline 유지
                    </button>
                    <button type="button" className="bulk-btn" onClick={() => applyBulk('excel')}>
                        모두 엑셀 적용
                    </button>
                </div>
            </div>

            <DiffTable
                items={visibleItems}
                decisions={decisions}
                onDecide={(path, value) => setDecisions(prev => ({ ...prev, [path]: value }))}
            />

            <div className="save-bar">
                {feedback && (
                    <div className={`feedback feedback-${feedback.type}`}>{feedback.msg}</div>
                )}
                <button
                    type="button"
                    className="btn-primary"
                    disabled={saving || decidedCount < totalReview}
                    onClick={onSave}
                >
                    {saving ? '저장 중...' : `prices.json 저장 (${decidedCount}/${totalReview})`}
                </button>
            </div>
        </div>
    )
}

function SummaryStats({ summary }) {
    const sb = summary.suspicionBreakdown
    return (
        <div className="summary-stats">
            <div className="stat"><span className="stat-num">{summary.unchanged}</span><span className="stat-label">일치</span></div>
            <div className="stat"><span className="stat-num">{summary.changed}</span><span className="stat-label">변경</span></div>
            <div className="stat"><span className="stat-num">{summary.missing_in_excel}</span><span className="stat-label">엑셀 비어있음</span></div>
            <div className="stat"><span className="stat-num">{summary.missing_in_baseline}</span><span className="stat-label">엑셀 신규</span></div>
            <div className="stat-divider" />
            <div className="stat sev-high"><span className="stat-num">{sb.digit_missing + sb.extra_digit}</span><span className="stat-label">자릿수 의심</span></div>
            <div className="stat sev-medium"><span className="stat-num">{sb.monotonicity_break}</span><span className="stat-label">단조성 위배</span></div>
        </div>
    )
}

function DiffTable({ items, decisions, onDecide }) {
    if (items.length === 0) {
        return <div className="diff-empty">표시할 항목이 없습니다.</div>
    }
    return (
        <div className="diff-table-wrap">
            <table className="diff-table">
                <thead>
                    <tr>
                        <th>경로</th>
                        <th className="num">baseline</th>
                        <th className="num">엑셀</th>
                        <th>상태</th>
                        <th>경고</th>
                        <th>설명</th>
                        <th>적용 값</th>
                    </tr>
                </thead>
                <tbody>
                    {items.map(item => {
                        const sev = SEVERITY_LABEL[item.severity] || SEVERITY_LABEL.info
                        const decision = decisions[item.path]
                        const fmt = v => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('ko-KR')
                        return (
                            <tr key={item.path} className={`diff-row ${sev.className}`}>
                                <td className="path-cell">{item.path}</td>
                                <td className="num">{fmt(item.baselineValue)}</td>
                                <td className="num">{fmt(item.excelValue)}</td>
                                <td>{STATUS_LABEL[item.status] || item.status}</td>
                                <td>
                                    <span className={`sev-badge ${sev.className}`} title={sev.help}>
                                        {sev.label}
                                    </span>
                                </td>
                                <td className="msg-cell">{item.message}</td>
                                <td>
                                    <div className="decision-toggle">
                                        <button
                                            type="button"
                                            className={`dec-btn ${decision === 'baseline' ? 'active' : ''}`}
                                            disabled={item.baselineValue === null}
                                            onClick={() => onDecide(item.path, 'baseline')}
                                        >
                                            baseline
                                        </button>
                                        <button
                                            type="button"
                                            className={`dec-btn ${decision === 'excel' ? 'active' : ''}`}
                                            disabled={item.excelValue === null}
                                            onClick={() => onDecide(item.path, 'excel')}
                                        >
                                            엑셀
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
