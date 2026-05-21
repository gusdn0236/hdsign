import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { shareImage } from '../../utils/shareImage.js';
import './KakaoShareButton.css';

// shareImage 의 반환값별 안내 토스트. 'shared'(공유 시트)·'aborted'(취소) 는 토스트 없음.
const TOAST_BY_RESULT = {
    copied: '이미지를 복사했어요. 카톡 대화창에 Ctrl+V 로 붙여넣으세요.',
    downloaded: '이미지를 저장했어요. 카톡 대화에 첨부해 보내세요.',
    error: '공유할 이미지를 준비하지 못했어요. 잠시 후 다시 시도해 주세요.',
};

/**
 * 카카오톡 공유 버튼 — 사진/지시서를 단말 환경에 맞춰 공유(공유 시트·클립보드·다운로드).
 * 어디에 놓이든 동일하게 동작하며, 결과 안내 토스트를 자체적으로 띄운다.
 *
 * @param {() => (object|null)} getSource  클릭 시점에 공유 소스를 만들어 반환.
 *        ({type:'url',url}) 또는 ({type:'canvas',canvas}). null 이면 "찾지 못함" 안내.
 * @param {string|(() => string)} fileName  공유/다운로드 파일명.
 * @param {string} [className]  버튼에 추가할 클래스(위치별 스타일).
 * @param {string} [label]      버튼 텍스트(기본 "카톡공유").
 * @param {boolean} [iconOnly]  true 면 아이콘만(좁은 공간용).
 */
export default function KakaoShareButton({
    getSource,
    fileName,
    className = '',
    label = '카톡공유',
    iconOnly = false,
}) {
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState('');
    const toastTimer = useRef(null);

    useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
    }, []);

    const showToast = useCallback((msg) => {
        if (!msg) return;
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 4500);
    }, []);

    const handleClick = useCallback(async (e) => {
        e.stopPropagation();
        if (busy) return;
        let source = null;
        try {
            source = typeof getSource === 'function' ? getSource() : getSource;
        } catch {
            source = null;
        }
        if (!source) {
            showToast('공유할 이미지를 찾지 못했어요.');
            return;
        }
        const name = typeof fileName === 'function' ? fileName() : fileName;
        setBusy(true);
        try {
            const result = await shareImage(source, name || 'image.jpg');
            showToast(TOAST_BY_RESULT[result]);
        } catch {
            showToast(TOAST_BY_RESULT.error);
        } finally {
            setBusy(false);
        }
    }, [busy, getSource, fileName, showToast]);

    return (
        <>
            <button
                type="button"
                className={`kko-share-btn${iconOnly ? ' kko-share-btn--icon' : ''}${className ? ` ${className}` : ''}`}
                onClick={handleClick}
                disabled={busy}
                title="카카오톡으로 공유"
                aria-label={label}
            >
                {busy ? (
                    <span className="kko-share-spinner" aria-hidden="true" />
                ) : (
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="5" cy="10" r="2.2" />
                        <circle cx="15" cy="5" r="2.2" />
                        <circle cx="15" cy="15" r="2.2" />
                        <path d="M7 9l6-3M7 11l6 3" />
                    </svg>
                )}
                {!iconOnly && <span>{label}</span>}
            </button>
            {/* 토스트는 body 로 포털 — 카드 hover 시 조상에 걸리는 transform 이
                position:fixed 기준을 바꿔 위치가 틀어지는 것을 피한다. */}
            {toast && createPortal(
                <div
                    className="kko-share-toast"
                    role="status"
                    onClick={(e) => { e.stopPropagation(); setToast(''); }}
                >
                    {toast}
                </div>,
                document.body,
            )}
        </>
    );
}
