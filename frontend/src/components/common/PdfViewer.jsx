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
    const [stageHeight, setStageHeight] = useState(0);
    // 첫 페이지 비율 (h/w) — 처음에 페이지 전체가 stage 안에 들어가도록 baseWidth 계산에 사용.
    const [pageAspect, setPageAspect] = useState(null);

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1);

    const [docLoading, setDocLoading] = useState(true);
    const [pageRendering, setPageRendering] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => { scaleRef.current = scale; }, [scale]);

    useEffect(() => {
        const measure = () => {
            if (stageRef.current) {
                setStageWidth(stageRef.current.clientWidth);
                setStageHeight(stageRef.current.clientHeight);
            }
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    useEffect(() => {
        setNumPages(0);
        setCurrentPage(1);
        setScale(1);
        setPageAspect(null);
        setDocLoading(true);
        setError('');
    }, [url]);

    // scale=1 일 때 페이지 전체가 stage 안에 들어가도록 — 폭·높이 중 작은 쪽에 맞춤.
    // canvas-wrap 의 padding 합계만큼 빼서 페이지+패딩이 stage 안에 정확히 들어가게 한다.
    // 이 보정이 없으면 한 쪽 dim 이 stage 와 정확히 일치해 패딩이 overflow 를 만들고
    // 의도치 않은 스크롤이 생겨 가운데 정렬도 어긋난다.
    // pageAspect 가 아직 없으면 (첫 렌더 직전) stageWidth 폴백 — 캔버스 그리기 전에
    // onLoadSuccess 가 먼저 와 곧바로 정확한 값으로 갱신됨.
    const baseWidth = useMemo(() => {
        if (!stageWidth) return 0;
        const PAD = 32; // .pv-canvas-wrap padding 16px × 2.
        const availW = Math.max(0, stageWidth - PAD);
        if (pageAspect && stageHeight) {
            const availH = Math.max(0, stageHeight - PAD);
            return Math.min(availW, availH / pageAspect);
        }
        return availW;
    }, [stageWidth, stageHeight, pageAspect]);

    const renderDpr = useMemo(() => {
        const native = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        return Math.min(native * scale, DPR_CAP);
    }, [scale]);

    /**
     * 줌 + scroll 보정. anchorClientX/Y 는 viewport(client) 좌표계의 점.
     * 줌 전후로 그 점이 페이지의 같은 분수(fractional) 위치를 가리키도록 스크롤을 맞춘다.
     * 안 주면 stage 가운데가 앵커.
     *
     * 옛 수식 (scrollLeft+anchor)*ratio-anchor 는 canvas-wrap 이 페이지 크기와 같다고 가정하지만,
     * 실제로는 작은 페이지일 때 min-width/height:100% + flex center 때문에 canvas-wrap 이
     * 늘어나 페이지가 wrap 안에서 가운데에 떠 있다. scale 변경 시 그 "떠 있는 오프셋" 이 달라지는
     * 데(작을 땐 크고, 커지면 0 에 가까워짐) 옛 수식이 이 변화를 반영 못해 scrollLeft 가 0 으로
     * 클램프돼 좌상단으로 점프하는 증상이 있었다.
     *
     * 새 방식 — 앵커 클라이언트 좌표가 페이지의 어느 분수 위치(fracX, fracY ∈ [0,1])에 있는지
     * 측정 → setScale 후 다음 프레임에 새 페이지 rect 기준으로 같은 분수 위치가 같은 클라이언트
     * 픽셀에 오도록 스크롤 보정. 페이지의 실제 DOM rect 를 쓰니까 flex 정렬/패딩과 무관하게 정확.
     */
    const zoomTo = useCallback((target, anchorClientX, anchorClientY) => {
        const stage = stageRef.current;
        if (!stage) return;
        const oldScale = scaleRef.current;
        const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, +target.toFixed(2)));
        if (clamped === oldScale) return;

        const stageRect = stage.getBoundingClientRect();
        const cx = anchorClientX != null ? anchorClientX : stageRect.left + stageRect.width / 2;
        const cy = anchorClientY != null ? anchorClientY : stageRect.top + stageRect.height / 2;

        // 앵커 클라이언트 좌표가 현재 페이지의 어느 분수 위치인지. 페이지 밖이면 [0,1] 로 클램프해
        // 가까운 모서리에 앵커한다 — 빈 패딩 영역에서 휠 굴려도 자연스럽게 동작.
        const pageEl = stage.querySelector('.pv-page');
        let fracX = 0.5, fracY = 0.5;
        if (pageEl) {
            const r = pageEl.getBoundingClientRect();
            if (r.width > 0) fracX = Math.max(0, Math.min(1, (cx - r.left) / r.width));
            if (r.height > 0) fracY = Math.max(0, Math.min(1, (cy - r.top) / r.height));
        }

        setScale(clamped);
        // Page 의 width prop 변경 → 래퍼 div 스타일은 React 커밋 직후 즉시 반영.
        // 다음 프레임에 새 페이지 rect 으로 같은 분수 위치를 같은 클라이언트 픽셀에 맞춘다.
        requestAnimationFrame(() => {
            const ns = stageRef.current;
            const np = ns?.querySelector('.pv-page');
            if (!ns || !np) return;
            const nr = np.getBoundingClientRect();
            const have = {
                x: nr.left + fracX * nr.width,
                y: nr.top + fracY * nr.height,
            };
            // (have - want) 만큼 스크롤을 더하면 페이지가 그만큼 왼/위로 밀려 want 에 정렬됨.
            ns.scrollLeft = Math.max(0, ns.scrollLeft + (have.x - cx));
            ns.scrollTop = Math.max(0, ns.scrollTop + (have.y - cy));
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

    // 휠 = 줌 — 마우스 포인터 위치를 앵커로. native 리스너 + passive:false 로
    // preventDefault 가능하게(React onWheel 은 일부 환경에서 passive 라 무시됨).
    // PDF 가 stage 보다 클 때의 스크롤은 드래그(onPanStart) 로 대체.
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
            // zoomTo 가 클라이언트 좌표를 받아 페이지 DOM rect 로 분수 좌표 계산 — 정렬/패딩 무관 정확.
            zoomTo(scaleRef.current + delta, e.clientX, e.clientY);
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

                <span className="pv-hint">휠 확대/축소 · 드래그 이동</span>

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
                                    width={baseWidth * scale}
                                    devicePixelRatio={renderDpr}
                                    renderMode="canvas"
                                    renderTextLayer={false}
                                    renderAnnotationLayer={false}
                                    onLoadSuccess={(page) => {
                                        const w = page.originalWidth;
                                        const h = page.originalHeight;
                                        if (w && h) setPageAspect(h / w);
                                    }}
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
