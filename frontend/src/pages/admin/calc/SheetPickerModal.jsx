import { useEffect, useState } from 'react'

/**
 * 엑셀 업로드 후, 카테고리별로 어떤 시트를 쓸지 사용자가 고르는 모달.
 *
 * 단가표 파일에 옛날 시트가 섞여있을 수 있어서 (예: 잔넬2023, 잔넬2024, 잔넬최신)
 * 자동으로 마지막 매칭을 추천하되 사용자가 드롭다운으로 바꿀 수 있게 한다.
 *
 * props:
 *   inspection: inspectXlsx() 결과 (sheetNames, candidates, suggested, categories, categoryLabels)
 *   onCancel:   ESC 또는 취소 → 업로드 처음으로
 *   onConfirm:  (sheetMap) → 파싱·diff 진행
 */
export default function SheetPickerModal({ inspection, onCancel, onConfirm }) {
    const { fileName, sheetNames, candidates, suggested, categories, categoryLabels } = inspection
    const [selection, setSelection] = useState(() => ({ ...suggested }))

    useEffect(() => {
        function onKey(e) { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const pickedCount = categories.filter(c => selection[c]).length

    return (
        <div className="qu-modal-backdrop" onClick={onCancel}>
            <div className="qu-modal qu-modal-sm" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">시트 선택</div>
                        <h2 className="qu-modal-title">어떤 시트로 비교할까요?</h2>
                        <div className="qu-modal-sub">{fileName} · 시트 {sheetNames.length}개</div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onCancel} aria-label="닫기">×</button>
                </header>

                <div className="qu-modal-body">
                    <p className="qu-picker-hint">
                        같은 카테고리에 시트가 여러 개면 가장 마지막 시트(보통 최신)가 자동 선택됨.
                        옛날 시트를 잘못 쓰지 않게 한 번씩 확인해주세요.
                    </p>

                    <div className="qu-picker-list">
                        {categories.map(cat => {
                            const opts = candidates[cat]
                            const hasNone = opts.length === 0
                            return (
                                <div key={cat} className={`qu-picker-row ${hasNone ? 'empty' : ''}`}>
                                    <div className="qu-picker-cat">
                                        <span className="qu-picker-cat-name">{categoryLabels[cat]}</span>
                                        {opts.length > 1 && (
                                            <span className="qu-picker-badge">{opts.length}개 발견</span>
                                        )}
                                    </div>
                                    <div className="qu-picker-select-wrap">
                                        <select
                                            className="qu-picker-select"
                                            value={selection[cat] || ''}
                                            onChange={e => setSelection(s => ({
                                                ...s,
                                                [cat]: e.target.value || null,
                                            }))}
                                        >
                                            <option value="">— 비교 안 함 —</option>
                                            {/* 카테고리에 매칭된 시트들을 먼저, 그 뒤 나머지 전체 시트 노출 */}
                                            {opts.length > 0 && (
                                                <optgroup label="추정 시트">
                                                    {opts.map(name => (
                                                        <option key={`m-${name}`} value={name}>{name}</option>
                                                    ))}
                                                </optgroup>
                                            )}
                                            <optgroup label="전체 시트">
                                                {sheetNames.map(name => (
                                                    <option key={`a-${name}`} value={name}>{name}</option>
                                                ))}
                                            </optgroup>
                                        </select>
                                    </div>
                                </div>
                            )
                        })}
                    </div>

                    {pickedCount === 0 && (
                        <div className="qu-picker-warn">
                            선택된 시트가 없습니다. 비교할 카테고리를 하나 이상 선택해주세요.
                        </div>
                    )}
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>취소</button>
                    <button
                        type="button"
                        className="qu-btn-apply"
                        onClick={() => onConfirm(selection)}
                        disabled={pickedCount === 0}
                    >
                        {pickedCount === 0 ? '시트 선택 필요' : `${pickedCount}개 카테고리로 비교`}
                    </button>
                </footer>
            </div>
        </div>
    )
}
