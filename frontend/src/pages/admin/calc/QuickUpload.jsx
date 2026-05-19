import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { inspectXlsx, parseXlsx } from '../../../utils/calc/parseXlsx'
import { computeDiff, buildPricesFromDecisions } from '../../../utils/calc/diffEngine'
import SheetPickerModal from './SheetPickerModal.jsx'
import ReviewModal from './ReviewModal.jsx'
import PricesViewerModal from './PricesViewerModal.jsx'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/**
 * 사이드바 — 드롭존 + 현재 단가 메타.
 *
 * 흐름:
 *   idle → (드롭) → inspecting → picker(시트선택 모달)
 *        → parsing → review(검토 모달) → confirm(모달 안 다이얼로그)
 *        → applying → done.
 * 검토/시트선택은 모달이 담당. 사이드바는 진입/상태만.
 */
export default function QuickUpload() {
    const { token } = useAuth()
    const [baseline, setBaseline] = useState(null)
    const [current, setCurrent] = useState(null)
    const [phase, setPhase] = useState('idle')     // idle | inspecting | picker | parsing | review | applying | done | error
    const [errorMsg, setErrorMsg] = useState(null)
    const [dragOver, setDragOver] = useState(false)
    const [fileName, setFileName] = useState(null)
    const [inspection, setInspection] = useState(null)
    const [parsed, setParsed] = useState(null)
    const [diff, setDiff] = useState(null)
    const [viewerOpen, setViewerOpen] = useState(false)
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
        setPhase('inspecting')
        setErrorMsg(null)
        setFileName(file.name)
        try {
            const ins = await inspectXlsx(file)
            setInspection(ins)
            setPhase('picker')
        } catch (err) {
            setPhase('error')
            setErrorMsg(String(err.message || err))
        }
    }

    async function handleSheetPicked(selection) {
        // selection: { sheetName, category }
        if (!inspection || !baseline) return
        setPhase('parsing')
        try {
            // parseXlsx 는 file 또는 buffer 둘 다 받음.
            const fakeFile = { name: inspection.fileName, arrayBuffer: async () => inspection.buffer }
            const p = await parseXlsx(fakeFile, baseline, selection)
            const d = computeDiff(baseline, p)
            setParsed(p)
            setDiff(d)
            setPhase('review')
        } catch (err) {
            setPhase('error')
            setErrorMsg(String(err.message || err))
        }
    }

    async function handleApply(decisions) {
        if (!diff || !baseline || !parsed) return
        setPhase('applying')
        try {
            // decisions: path → 'excel' | 'baseline'. diff 도 같이 넘겨서 빈칸(missing_in_excel)
            // 셀이 'excel' 결정 시 baseline 의 해당 사이즈 키를 제거하도록 함 (가격 시프트 갱신 지원).
            const newPrices = buildPricesFromDecisions(baseline, parsed, decisions, diff)
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
        setInspection(null)
        setParsed(null)
        setDiff(null)
        setFileName(null)
        setErrorMsg(null)
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

    const showingPicker = phase === 'picker' && inspection
    const showingReview = phase === 'review' && diff

    return (
        <>
            <aside className="qu-card">
                <div className="qu-title">단가표 업로드</div>
                <div className="qu-sub">
                    {phase === 'idle'       && '엑셀을 올리면 단가가 어떻게 바뀌는지 알려드려요'}
                    {phase === 'inspecting' && '파일 읽는 중...'}
                    {phase === 'picker'     && '시트를 골라주세요'}
                    {phase === 'parsing'    && '단가 비교하는 중...'}
                    {phase === 'review'     && '바뀐 곳 확인해주세요'}
                    {phase === 'applying'   && '단가표에 반영하는 중...'}
                    {phase === 'done'       && '반영 완료!'}
                    {phase === 'error'      && '문제가 생겼어요'}
                </div>

                {(phase === 'idle' || phase === 'error') && (
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
                        <div className="qu-drop-text">새 단가표(.xlsx)를<br/>여기로 끌어다 놓거나 클릭하세요</div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".xlsx,.xlsm"
                            style={{ display: 'none' }}
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                        />
                    </div>
                )}

                {(phase === 'inspecting' || phase === 'parsing' || phase === 'applying') && (
                    <div className="qu-busy">
                        {phase === 'inspecting' && '파일 읽고 있어요...'}
                        {phase === 'parsing'    && '단가표 비교하는 중...'}
                        {phase === 'applying'   && '단가표에 반영하는 중...'}
                    </div>
                )}

                {(phase === 'picker' || phase === 'review') && (
                    <div className="qu-side-progress">
                        <div className="qu-side-progress-file">{fileName}</div>
                        <div className="qu-side-progress-step">
                            {phase === 'picker' ? '1단계 · 시트 선택' : '2단계 · 바뀐 곳 확인'}
                        </div>
                        <button type="button" className="qu-btn-cancel" onClick={reset}>처음으로</button>
                    </div>
                )}

                {phase === 'done' && (
                    <div className="qu-done">
                        <div className="qu-check">✓</div>
                        <div className="qu-done-title">단가표에 잘 반영했어요</div>
                        <div className="qu-done-meta">
                            {new Date().toLocaleTimeString('ko-KR')}<br/>{fileName}
                        </div>
                        <button type="button" className="qu-btn-cancel" onClick={reset} style={{ marginTop: 12 }}>
                            다른 단가표 올리기
                        </button>
                    </div>
                )}

                {phase === 'error' && errorMsg && (
                    <div className="qu-error-block">
                        <div className="qu-error-title">문제가 생겼어요</div>
                        <div className="qu-error-body">{errorMsg}</div>
                        <button type="button" className="qu-btn-cancel" onClick={reset} style={{ marginTop: 8 }}>
                            처음부터 다시
                        </button>
                    </div>
                )}

                <div className="qu-current">
                    <div className="qu-current-label">현재 적용 중인 단가</div>
                    <div className="qu-current-meta">
                        {current?._meta?.builtAt
                            ? `마지막 갱신: ${new Date(current._meta.builtAt).toLocaleString('ko-KR')}`
                            : '아직 한 번도 갱신 안 됨 (초기 단가표 사용 중)'}
                    </div>
                    <button
                        type="button"
                        className="qu-view-prices-btn"
                        onClick={() => setViewerOpen(true)}
                        disabled={!current}
                    >
                        📋 현재 단가표 표로 보기
                    </button>
                </div>
            </aside>

            {showingPicker && (
                <SheetPickerModal
                    inspection={inspection}
                    onCancel={reset}
                    onConfirm={handleSheetPicked}
                />
            )}

            {showingReview && (
                <ReviewModal
                    diff={diff}
                    baseline={baseline}
                    fileName={fileName}
                    onCancel={reset}
                    onApply={handleApply}
                />
            )}

            {viewerOpen && current && (
                <PricesViewerModal
                    prices={current}
                    onClose={() => setViewerOpen(false)}
                />
            )}
        </>
    )
}
