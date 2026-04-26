import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './PdfViewer.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.25;
const DPR_CAP = 6;

export default function PdfViewer({ url }) {
    const stageRef = useRef(null);
    const [stageWidth, setStageWidth] = useState(0);

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1);

    const [docLoading, setDocLoading] = useState(true);
    const [pageRendering, setPageRendering] = useState(false);
    const [error, setError] = useState('');

    // 폭 측정 — window resize 만 듣는다. 스테이지 내부 콘텐츠가 커져 스크롤바가
    // 생길 때 ResizeObserver 가 폭을 다시 잡으면 무한 루프가 발생하므로 의도적으로 제외.
    useEffect(() => {
        const measure = () => {
            if (stageRef.current) setStageWidth(stageRef.current.clientWidth);
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    useEffect(() => {
        setNumPages(0);
        setCurrentPage(1);
        setScale(1);
        setDocLoading(true);
        setError('');
    }, [url]);

    const renderDpr = useMemo(() => {
        const native = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        return Math.min(native * scale, DPR_CAP);
    }, [scale]);

    const zoomIn = useCallback(() => {
        setScale((s) => Math.min(MAX_SCALE, +(s + ZOOM_STEP).toFixed(2)));
    }, []);
    const zoomOut = useCallback(() => {
        setScale((s) => Math.max(MIN_SCALE, +(s - ZOOM_STEP).toFixed(2)));
    }, []);
    const zoomReset = useCallback(() => setScale(1), []);

    // Ctrl+휠 줌. 네이티브 리스너 + passive:false 로 preventDefault 가능하게.
    // (React 의 onWheel 은 일부 환경에서 passive 라 preventDefault 가 무시됨)
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (e.deltaY < 0) zoomIn();
                else zoomOut();
            }
            // Ctrl 없는 휠은 기본 스크롤(스테이지 내부) 그대로 둔다.
            // 뒷배경 전파는 CSS overscroll-behavior:contain + 모달 body 락 으로 차단.
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
    }, [zoomIn, zoomOut]);

    // 클릭 드래그로 스테이지 스크롤 이동 (확대 시 PDF 가 스테이지보다 커져 스크롤 가능할 때).
    const onPanStart = useCallback((e) => {
        if (e.button !== 0) return;
        const stage = stageRef.current;
        if (!stage) return;
        const canPan = stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight;
        if (!canPan) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const startScrollLeft = stage.scrollLeft;
        const startScrollTop = stage.scrollTop;
        stage.classList.add('pv-stage--panning');
        e.preventDefault();

        const onMove = (ev) => {
            stage.scrollLeft = startScrollLeft - (ev.clientX - startX);
            stage.scrollTop = startScrollTop - (ev.clientY - startY);
        };
        const onUp = () => {
            stage.classList.remove('pv-stage--panning');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    const onDocLoad = useCallback(({ numPages: n }) => {
        setNumPages(n);
        setCurrentPage(1);
        setDocLoading(false);
        setError('');
    }, []);
    const onDocError = useCallback((err) => {
        setDocLoading(false);
        setError(err?.message || 'PDF 를 표시할 수 없습니다.');
    }, []);

    return (
        <div className="pv-wrap">
            <div className="pv-controls">
                <button
                    type="button"
                    onClick={zoomOut}
                    disabled={scale <= MIN_SCALE}
                    className="pv-btn"
                    aria-label="축소"
                >－</button>
                <span className="pv-scale">{Math.round(scale * 100)}%</span>
                <button
                    type="button"
                    onClick={zoomIn}
                    disabled={scale >= MAX_SCALE}
                    className="pv-btn"
                    aria-label="확대"
                >＋</button>
                <button
                    type="button"
                    onClick={zoomReset}
                    className="pv-btn pv-btn-ghost"
                >원래대로</button>

                <span className="pv-hint">Ctrl+휠 확대 · 드래그 이동</span>

                {numPages > 1 && (
                    <div className="pv-pager">
                        <button
                            type="button"
                            className="pv-btn"
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            disabled={currentPage <= 1}
                            aria-label="이전 페이지"
                        >‹</button>
                        <span className="pv-pager-text">{currentPage} / {numPages}</span>
                        <button
                            type="button"
                            className="pv-btn"
                            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                            disabled={currentPage >= numPages}
                            aria-label="다음 페이지"
                        >›</button>
                    </div>
                )}
            </div>

            <div className="pv-stage" ref={stageRef} onMouseDown={onPanStart}>
                {/* canvas-wrap — flex 컨테이너로 페이지를 가운데 정렬하면서 스테이지보다
                    커지면 자연스럽게 overflow 발생시켜 스크롤 가능하게. min-width/height
                    100% 로 작은 페이지일 때도 스테이지 전체를 채워 grab 영역 확보. */}
                <div className="pv-canvas-wrap">
                    {stageWidth > 0 && (
                        <Document
                            file={url}
                            onLoadSuccess={onDocLoad}
                            onLoadError={onDocError}
                            loading={null}
                            error={null}
                            noData={null}
                        >
                            {numPages > 0 && (
                                <Page
                                    key={`p-${currentPage}-${scale}`}
                                    pageNumber={currentPage}
                                    width={stageWidth * scale}
                                    devicePixelRatio={renderDpr}
                                    renderMode="canvas"
                                    renderTextLayer={false}
                                    renderAnnotationLayer={false}
                                    onRenderStart={() => setPageRendering(true)}
                                    onRenderSuccess={() => setPageRendering(false)}
                                    onRenderError={() => setPageRendering(false)}
                                    loading={null}
                                    className="pv-page"
                                />
                            )}
                        </Document>
                    )}
                </div>

                {(docLoading || pageRendering) && (
                    <div className="pv-loading" role="status" aria-live="polite">
                        <div className="pv-spinner" />
                        <span>{docLoading ? 'PDF 불러오는 중...' : '페이지 그리는 중...'}</span>
                    </div>
                )}

                {error && <div className="pv-error">{error}</div>}
            </div>
        </div>
    );
}
