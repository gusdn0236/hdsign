import { useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './PdfPanZoom.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * 마우스 드래그로 좌우/상하 이동, +/- 버튼으로 확대·축소, 더블클릭 시 토글 줌.
 * 단축키 모르는 사용자도 버튼만으로 조작 가능하도록 설계.
 */
export default function PdfPanZoom({ url }) {
    const wrapRef = useRef(null);
    const [numPages, setNumPages] = useState(0);
    const [pageWidth, setPageWidth] = useState(0);
    const [error, setError] = useState('');

    useEffect(() => {
        const measure = () => {
            if (!wrapRef.current) return;
            const w = wrapRef.current.clientWidth - 16;
            setPageWidth(Math.max(280, w));
        };
        measure();
        const ro = new ResizeObserver(measure);
        if (wrapRef.current) ro.observe(wrapRef.current);
        window.addEventListener('resize', measure);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, []);

    // url 바뀌면 페이지 수 리셋
    useEffect(() => {
        setNumPages(0);
        setError('');
    }, [url]);

    const onLoad = useCallback(({ numPages: n }) => {
        setNumPages(n);
        setError('');
    }, []);
    const onErr = useCallback((err) => {
        setError(err?.message || 'PDF 표시 실패');
    }, []);

    return (
        <div className="ppz-wrap" ref={wrapRef}>
            <TransformWrapper
                initialScale={1}
                minScale={0.5}
                maxScale={4}
                doubleClick={{ mode: 'toggle', step: 1.5 }}
                // 마우스 휠 한 칸은 deltaY ~100 이라 step 이 크면 한 번에 끝까지 확대됨.
                // 0.06 정도가 마우스 휠로 자연스럽게 단계별 확대되는 강도.
                wheel={{ step: 0.06, smoothStep: 0.005 }}
                pinch={{ step: 5 }}
                panning={{ velocityDisabled: true }}
            >
                {({ zoomIn, zoomOut, resetTransform }) => (
                    <>
                        <div className="ppz-controls">
                            <button
                                type="button"
                                className="ppz-btn"
                                onClick={() => zoomIn()}
                                title="확대"
                                aria-label="확대"
                            >
                                <span className="ppz-btn-icon">＋</span>
                                <span className="ppz-btn-text">확대</span>
                            </button>
                            <button
                                type="button"
                                className="ppz-btn"
                                onClick={() => zoomOut()}
                                title="축소"
                                aria-label="축소"
                            >
                                <span className="ppz-btn-icon">－</span>
                                <span className="ppz-btn-text">축소</span>
                            </button>
                            <button
                                type="button"
                                className="ppz-btn ppz-btn-reset"
                                onClick={() => resetTransform()}
                                title="원래대로"
                                aria-label="원래대로"
                            >
                                <span className="ppz-btn-icon">⟲</span>
                                <span className="ppz-btn-text">원래대로</span>
                            </button>
                        </div>

                        <TransformComponent
                            wrapperClass="ppz-tc-wrapper"
                            contentClass="ppz-tc-content"
                        >
                            {pageWidth > 0 && (
                                <Document
                                    file={url}
                                    onLoadSuccess={onLoad}
                                    onLoadError={onErr}
                                    loading={<div className="ppz-msg">PDF 불러오는 중…</div>}
                                    error={<div className="ppz-msg error">PDF 표시 실패</div>}
                                    noData={<div className="ppz-msg">PDF 없음</div>}
                                >
                                    {Array.from({ length: numPages }, (_, i) => (
                                        <Page
                                            key={i}
                                            pageNumber={i + 1}
                                            width={pageWidth}
                                            renderAnnotationLayer={false}
                                            renderTextLayer={false}
                                            className="ppz-page"
                                        />
                                    ))}
                                </Document>
                            )}
                        </TransformComponent>
                    </>
                )}
            </TransformWrapper>
            {error && <div className="ppz-msg error ppz-msg-floating">{error}</div>}
            <div className="ppz-hint">드래그로 이동 · 더블클릭으로 확대</div>
        </div>
    );
}
