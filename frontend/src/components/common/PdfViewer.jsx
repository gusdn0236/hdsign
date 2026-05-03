import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

    // 다음 렌더가 끝나면 적용할 줌 앵커. zoomTo 가 시각 좌표(cx,cy)와 페이지 분수(fracX/Y) 를
    // 채워두면, useLayoutEffect 가 setScale 후 새 DOM 으로 같은 분수 위치가 같은 시각 좌표에
    // 오도록 스크롤을 정확히 보정. 옛날엔 setScale + rAF 방식이었는데 react-pdf 의 wrapper
    // 가 즉시 새 크기로 안 잡혀 측정값이 빗나가 매 휠마다 상단으로 점프하는 버그가 있었다.
    const pendingZoomRef = useRef(null);

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
     * 동작 — 앵커 클라이언트 좌표가 현재 페이지의 어느 분수 위치(fracX/Y ∈ [0,1])에 있는지
     * 측정해 pendingZoomRef 에 저장 → setScale → useLayoutEffect 가 React 커밋 직후 새
     * 페이지 DOM rect 기준으로 같은 분수 위치가 같은 클라이언트 픽셀에 오도록 스크롤 보정.
     * (rAF 방식은 react-pdf 의 wrapper 가 그 시점에 새 크기로 못 잡혀 자주 빗나갔다.)
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

        // 다음 커밋 후 useLayoutEffect 에서 적용. 클라이언트 좌표 cx/cy 와 분수 위치 fracX/Y
        // 만으로 충분 — 새 DOM 에서 페이지 rect 다시 읽어 같은 픽셀에 오도록 스크롤 보정.
        pendingZoomRef.current = { fracX, fracY, cx, cy };
        setScale(clamped);
    }, []);

    // setScale 후 React 커밋 직후 동기 실행 — 이 시점엔 page wrapper 의 width/height 가
    // 새 prop 으로 반영돼 있어 getBoundingClientRect 가 새 크기를 돌려준다 (rAF 방식보다 안정).
    useLayoutEffect(() => {
        const pending = pendingZoomRef.current;
        if (!pending) return;
        pendingZoomRef.current = null;
        const ns = stageRef.current;
        const np = ns?.querySelector('.pv-page');
        if (!ns || !np) return;
        const nr = np.getBoundingClientRect();
        const haveX = nr.left + pending.fracX * nr.width;
        const haveY = nr.top + pending.fracY * nr.height;
        // (have - want) 만큼 스크롤을 더하면 페이지가 그만큼 왼/위로 밀려 want 에 정렬됨.
        ns.scrollLeft = Math.max(0, ns.scrollLeft + (haveX - pending.cx));
        ns.scrollTop = Math.max(0, ns.scrollTop + (haveY - pending.cy));
    }, [scale]);

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
                                        const viewport = page.getViewport({ scale: 1 });
                                        const w = viewport?.width || page.originalWidth;
                                        const h = viewport?.height || page.originalHeight;
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
