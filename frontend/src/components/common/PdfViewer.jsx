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
    const scaleRef = useRef(1);
    const [stageWidth, setStageWidth] = useState(0);

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1);

    const [docLoading, setDocLoading] = useState(true);
    const [pageRendering, setPageRendering] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => { scaleRef.current = scale; }, [scale]);

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

    /**
     * 줌 + scroll 보정. anchorX/Y 는 stage 좌표계(0..clientWidth/Height) 위 한 점으로,
     * 줌 전후로 그 점이 화면상 같은 위치에 머물도록 새 scrollLeft/Top 을 계산.
     * 안 주면 stage 가운데를 기준으로 확대.
     *
     * 수식 — 줌 전 stage 좌표계의 점 (ax, ay) 가 콘텐츠상 위치는 (scrollL+ax, scrollT+ay).
     * 새 scale 에서 그 콘텐츠 위치는 ratio 배 — (scrollL+ax)·r, (scrollT+ay)·r.
     * 그 점을 다시 (ax, ay) 에 두려면 newScroll = oldPos·r - anchor.
     */
    const zoomTo = useCallback((target, anchorX, anchorY) => {
        const stage = stageRef.current;
        if (!stage) return;
        const oldScale = scaleRef.current;
        const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, +target.toFixed(2)));
        if (clamped === oldScale) return;

        const ax = anchorX != null ? anchorX : stage.clientWidth / 2;
        const ay = anchorY != null ? anchorY : stage.clientHeight / 2;
        const ratio = clamped / oldScale;
        const targetX = (stage.scrollLeft + ax) * ratio - ax;
        const targetY = (stage.scrollTop + ay) * ratio - ay;

        setScale(clamped);
        // Page 의 width prop 변경 → 래퍼 div 스타일은 React 커밋 직후 즉시 반영.
        // 다음 프레임에 새 scrollWidth/Height 기준으로 scroll 보정.
        requestAnimationFrame(() => {
            if (!stageRef.current) return;
            stageRef.current.scrollLeft = Math.max(0, targetX);
            stageRef.current.scrollTop = Math.max(0, targetY);
        });
    }, []);

    const zoomIn = useCallback(() => {
        zoomTo(scaleRef.current + ZOOM_STEP);
    }, [zoomTo]);
    const zoomOut = useCallback(() => {
        zoomTo(scaleRef.current - ZOOM_STEP);
    }, [zoomTo]);
    const zoomReset = useCallback(() => {
        const stage = stageRef.current;
        setScale(1);
        if (stage) {
            requestAnimationFrame(() => {
                stage.scrollLeft = 0;
                stage.scrollTop = 0;
            });
        }
    }, []);

    // Ctrl+휠 줌 — 마우스 포인터 위치를 앵커로. native 리스너 + passive:false 로
    // preventDefault 가능하게(React onWheel 은 일부 환경에서 passive 라 무시됨).
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const rect = stage.getBoundingClientRect();
            const ax = e.clientX - rect.left;
            const ay = e.clientY - rect.top;
            const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
            zoomTo(scaleRef.current + delta, ax, ay);
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
    }, [zoomTo]);

    // 클릭 드래그로 스크롤 이동 — 확대 상태에서만 동작.
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
                {/* canvas-wrap — block 레이아웃. width: max-content + min-width: 100% 로
                    페이지가 작으면 stage 폭, 크면 페이지 폭. .pv-page 의 margin: 0 auto
                    가 작은 경우만 가운데 정렬하고 큰 경우엔 자연스레 무력화됨.
                    flex justify-content:center 는 양쪽 overflow 를 만들어 좌측 영역이
                    scroll 0 미만이라 닿을 수 없는 문제가 있어 사용 X. */}
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
                                    /* key 에 scale 미포함 — 스케일 변경 시 unmount 없이
                                       width prop 만 갱신해 부드럽게 재렌더. */
                                    key={`p-${currentPage}`}
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
