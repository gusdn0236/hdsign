import { useEffect, useMemo, useState } from 'react'

/**
 * 시트 선택 모달.
 *
 * 단가표 파일은 보통 한 카테고리(예: 잔넬) 안에도
 *   "잔넬24.7월인상적용", "잔넬26.5인상적용" 같이 시기별 시트가 여러 개 들어있다.
 * 그래서 카테고리를 묻는 게 아니라, **비교 기준이 될 시트 하나**를 사용자가 직접 고른다.
 *
 * 시트 이름에서 종류(잔넬/스카시/아크릴/금은경/에폭시) 를 자동 추정해 디폴트로 채워주고,
 * 추정이 잘못됐을 때를 위해 종류 드롭다운을 같이 제공한다.
 *
 * props:
 *   inspection: inspectXlsx() 결과 (fileName, sheets, suggested, categories, categoryLabels)
 *   onCancel:   ESC / 취소
 *   onConfirm:  ({ sheetName, category }) → 파싱·diff 진행
 */
export default function SheetPickerModal({ inspection, onCancel, onConfirm }) {
    const { fileName, sheets, suggested, categories, categoryLabels } = inspection

    const [selectedName, setSelectedName] = useState(suggested?.name || sheets[0]?.name || '')

    const sheetByName = useMemo(() => {
        const m = {}
        for (const s of sheets) m[s.name] = s
        return m
    }, [sheets])

    const selectedSheet = sheetByName[selectedName]

    const [category, setCategory] = useState(selectedSheet?.inferred || '')

    // 시트 바꿀 때마다 자동으로 추정 카테고리 다시 채움 (사용자가 수동으로 바꿔도 시트 바꾸면 재추정)
    useEffect(() => {
        setCategory(selectedSheet?.inferred || '')
    }, [selectedName, selectedSheet])

    useEffect(() => {
        function onKey(e) { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const canConfirm = Boolean(selectedName && category)
    const cta = !selectedName
        ? '먼저 시트를 골라주세요'
        : !category
            ? '시트 종류를 골라주세요'
            : '바뀐 곳 확인해보기'

    return (
        <div className="qu-modal-backdrop" onClick={onCancel}>
            <div className="qu-modal qu-modal-sm" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">단계 1 / 2 · 시트 선택</div>
                        <h2 className="qu-modal-title">어떤 시트의 단가로 비교할까요?</h2>
                        <div className="qu-modal-sub">
                            <strong>{fileName}</strong> 안에 시트가 {sheets.length}개 있어요.
                            <br/>옛날 시트가 섞여있을 수 있으니, <strong>최신 시트 하나</strong>만 골라주세요.
                        </div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onCancel} aria-label="닫기">×</button>
                </header>

                <div className="qu-modal-body">
                    <div className="qu-sheet-list">
                        {sheets.map(s => {
                            const isOn = s.name === selectedName
                            const inferredLabel = s.inferred ? categoryLabels[s.inferred] : null
                            return (
                                <label
                                    key={s.name}
                                    className={`qu-sheet-item ${isOn ? 'on' : ''}`}
                                >
                                    <input
                                        type="radio"
                                        name="qu-sheet"
                                        checked={isOn}
                                        onChange={() => setSelectedName(s.name)}
                                    />
                                    <span className="qu-sheet-name">{s.name}</span>
                                    {inferredLabel ? (
                                        <span className="qu-sheet-badge inferred">{inferredLabel}로 추정</span>
                                    ) : (
                                        <span className="qu-sheet-badge unknown">종류 모름</span>
                                    )}
                                </label>
                            )
                        })}
                    </div>

                    <div className="qu-cat-picker">
                        <div className="qu-cat-label">이 시트를 어떤 종류의 단가로 볼까요?</div>
                        <select
                            className="qu-picker-select"
                            value={category}
                            onChange={e => setCategory(e.target.value)}
                        >
                            <option value="">— 종류 선택 —</option>
                            {categories.map(c => (
                                <option key={c} value={c}>{categoryLabels[c]}</option>
                            ))}
                        </select>
                        <div className="qu-cat-hint">
                            {selectedSheet?.inferred
                                ? `시트 이름으로 자동으로 "${categoryLabels[selectedSheet.inferred]}"로 추정했어요. 잘못됐으면 바꿔주세요.`
                                : '시트 이름에서 종류를 알 수 없어요. 직접 골라주세요.'}
                        </div>
                    </div>
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>취소</button>
                    <button
                        type="button"
                        className="qu-btn-apply"
                        onClick={() => onConfirm({ sheetName: selectedName, category })}
                        disabled={!canConfirm}
                    >
                        {cta}
                    </button>
                </footer>
            </div>
        </div>
    )
}
