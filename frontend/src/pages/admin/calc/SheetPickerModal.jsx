import { useEffect, useState } from 'react'

/**
 * 시트 선택 모달.
 *
 * 단가표 파일은 잔넬 단가만 다루고, 한 시트 안에 갈바후광영문/한글/오사이/캡/일체형/
 * 타카/스텐알미늄캡/스텐오사이/스텐후광/골드스텐 모든 잔넬 종류가 들어있다.
 * 시트는 시기별 버전 ("잔넬24.7월인상적용", "잔넬26.5인상적용") 으로 여러 개라 —
 * 사용자가 최신 시트 하나를 골라 비교한다.
 *
 * props:
 *   inspection: inspectXlsx() 결과 (fileName, sheetNames, suggested)
 *   onCancel:   ESC / 취소
 *   onConfirm:  (sheetName: string) → 파싱·diff 진행
 */
export default function SheetPickerModal({ inspection, onCancel, onConfirm }) {
    const { fileName, sheetNames, suggested } = inspection

    const [selectedName, setSelectedName] = useState(suggested || sheetNames[0] || '')

    useEffect(() => {
        function onKey(e) { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const canConfirm = Boolean(selectedName)

    return (
        <div className="qu-modal-backdrop" onClick={onCancel}>
            <div className="qu-modal qu-modal-sm" onClick={e => e.stopPropagation()}>
                <header className="qu-modal-head">
                    <div>
                        <div className="qu-modal-eyebrow">단계 1 / 2 · 시트 선택</div>
                        <h2 className="qu-modal-title">어떤 시트의 단가로 비교할까요?</h2>
                        <div className="qu-modal-sub">
                            <strong>{fileName}</strong> 안에 시트가 {sheetNames.length}개 있어요.
                            <br/>옛날 시트가 섞여있을 수 있으니, <strong>최신 시트 하나</strong>만 골라주세요.
                        </div>
                    </div>
                    <button type="button" className="qu-modal-close" onClick={onCancel} aria-label="닫기">×</button>
                </header>

                <div className="qu-modal-body">
                    <div className="qu-sheet-list">
                        {sheetNames.map(name => {
                            const isOn = name === selectedName
                            return (
                                <label
                                    key={name}
                                    className={`qu-sheet-item ${isOn ? 'on' : ''}`}
                                >
                                    <input
                                        type="radio"
                                        name="qu-sheet"
                                        checked={isOn}
                                        onChange={() => setSelectedName(name)}
                                    />
                                    <span className="qu-sheet-name">{name}</span>
                                </label>
                            )
                        })}
                    </div>
                </div>

                <footer className="qu-modal-foot">
                    <button type="button" className="qu-btn-cancel" onClick={onCancel}>취소</button>
                    <button
                        type="button"
                        className="qu-btn-apply"
                        onClick={() => onConfirm(selectedName)}
                        disabled={!canConfirm}
                    >
                        {!selectedName ? '먼저 시트를 골라주세요' : '바뀐 곳 확인해보기'}
                    </button>
                </footer>
            </div>
        </div>
    )
}
