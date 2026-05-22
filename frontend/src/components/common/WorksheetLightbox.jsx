import { useCallback, useEffect, useRef } from 'react';
import PdfViewer from './PdfViewer.jsx';
import './WorksheetLightbox.css';

/**
 * 작업지시서 확대 보기 라이트박스 — 현장 뷰어 카드 썸네일의 돋보기로 연다.
 *
 * items 안에서 orderNumber 로 현재 항목을 찾으므로, 거래처 검색으로 필터된 목록을
 * 그대로 넘기면 ←/→ 이동도 그 필터된 범위 안에서만 순환한다. 폴링으로 목록이
 * 갱신돼도 orderNumber 기준이라 같은 지시서를 계속 가리킨다.
 *
 * confirmActive=true (부모의 '여시겠습니까?' 확인창이 떠 있음) 면 키 입력을 부모에
 * 양보한다 — 그땐 ←/→ 가 지시서 이동이 아니라 [FS에서 열기]/[폴더열기] 선택용이라
 * 라이트박스 자체 키 처리를 멈춰야 한다.
 */
export default function WorksheetLightbox({
    items,
    orderNumber,
    onClose,
    onNavigate,
    onRequestOpen,
    confirmActive,
}) {
    const backdropRef = useRef(null);
    const index = items.findIndex((it) => it.orderNumber === orderNumber);
    const item = index >= 0 ? items[index] : null;
    const hasPrev = index > 0;
    const hasNext = index >= 0 && index < items.length - 1;

    const goPrev = useCallback(() => {
        if (index > 0) onNavigate(items[index - 1].orderNumber);
    }, [index, items, onNavigate]);
    const goNext = useCallback(() => {
        if (index >= 0 && index < items.length - 1) onNavigate(items[index + 1].orderNumber);
    }, [index, items, onNavigate]);

    // 현재 항목이 목록에서 사라지면(폴링으로 완료 처리·필터 변경 등) 라이트박스를 닫는다.
    useEffect(() => {
        if (index < 0) onClose();
    }, [index, onClose]);

    // 열릴 때 포커스를 라이트박스로 가져와, 뒤의 카드 영역 키 핸들러와 겹치지 않게 한다.
    useEffect(() => {
        backdropRef.current?.focus();
    }, []);

    // ESC 닫기 / ←·→ 이전·다음 지시서 / Enter 로 '여시겠습니까?' 확인창 띄우기.
    // confirmActive 면 키는 부모(확인창)가 처리하므로 여기선 아무것도 안 한다.
    useEffect(() => {
        const onKey = (e) => {
            if (confirmActive) return;
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
            // e.repeat 제외 — Enter 를 누른 채 있어도 확인창이 한 번만, 확실히 뜨도록(오토리피트 무시).
            else if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat && item) onRequestOpen(item); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [confirmActive, onClose, goPrev, goNext, onRequestOpen, item]);

    // 라이트박스 떠 있는 동안 뒤 배경 스크롤 잠금.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);

    if (!item) return null;

    return (
        <div
            className="wlb-backdrop"
            ref={backdropRef}
            tabIndex={-1}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <button type="button" className="wlb-close" onClick={onClose} aria-label="닫기">×</button>

            {items.length > 1 && (
                <button
                    type="button"
                    className="wlb-nav wlb-nav-prev"
                    onClick={goPrev}
                    disabled={!hasPrev}
                    aria-label="이전 지시서"
                >‹</button>
            )}

            <div className="wlb-stage">
                <div className="wlb-head">
                    <span className="wlb-title">
                        {item.companyName || '거래처 미상'}{item.title ? ` · ${item.title}` : ''}
                    </span>
                    <span className="wlb-head-right">
                        {items.length > 1 && (
                            <span className="wlb-counter">{index + 1} / {items.length}</span>
                        )}
                        <span className="wlb-hint">← → 지시서 이동 · Enter 열기 · Esc 닫기</span>
                    </span>
                </div>
                <div className="wlb-body">
                    {item.worksheetPdfUrl ? (
                        <PdfViewer url={item.worksheetPdfUrl} />
                    ) : item.worksheetThumbnailUrl ? (
                        <img className="wlb-img" src={item.worksheetThumbnailUrl} alt="" />
                    ) : (
                        <div className="wlb-empty">미리보기가 없는 지시서입니다.</div>
                    )}
                </div>
            </div>

            {items.length > 1 && (
                <button
                    type="button"
                    className="wlb-nav wlb-nav-next"
                    onClick={goNext}
                    disabled={!hasNext}
                    aria-label="다음 지시서"
                >›</button>
            )}
        </div>
    );
}
