import './CompletionConfirmModal.css';

/**
 * 작업완료 여부 확인 모달.
 * 사진 업로드 직후 또는 [작업완료] 버튼 클릭 시 시스템 confirm 대신 노출.
 *
 * props:
 *  - open: boolean
 *  - title: string (기본 "작업이 완료되었나요?")
 *  - description: string (옵션 — 본문 보조 문장)
 *  - onYes: () => void
 *  - onNo: () => void
 *  - onClose: () => void (backdrop 클릭, 기본은 onNo 와 같이 처리)
 *  - busy: boolean (네 버튼 처리 중 표시)
 */
export default function CompletionConfirmModal({
    open,
    title = '작업이 완료되었나요?',
    description = '사진 업로드가 완료됐어요. 이번 작업을 완료 처리할까요?',
    onYes,
    onNo,
    onClose,
    busy = false,
}) {
    if (!open) return null;
    const handleBackdrop = () => {
        if (busy) return;
        if (onClose) onClose();
        else if (onNo) onNo();
    };
    return (
        <div className="ccm-backdrop" onClick={handleBackdrop} role="dialog" aria-modal="true">
            <div className="ccm-card" onClick={(e) => e.stopPropagation()}>
                <div className="ccm-icon" aria-hidden="true">✓</div>
                <h2 className="ccm-title">{title}</h2>
                <p className="ccm-desc">{description}</p>
                <div className="ccm-actions">
                    <button
                        type="button"
                        className="ccm-btn ccm-btn-yes"
                        onClick={onYes}
                        disabled={busy}
                    >
                        {busy ? '처리 중…' : '네, 작업이 다 끝났어요'}
                    </button>
                    <button
                        type="button"
                        className="ccm-btn ccm-btn-no"
                        onClick={onNo}
                        disabled={busy}
                    >
                        아니요, 작업이 아직 남았어요
                    </button>
                </div>
            </div>
        </div>
    );
}
