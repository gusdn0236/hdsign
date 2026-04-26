import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './PdfViewer.css';

// Web Worker — Vite ?url 로 worker.mjs 를 정적 자산으로 번들. CDN 의존 X.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.25;
const DPR_CAP = 6;

/**
 * 모달 내부용 PDF 뷰어. iframe 대비 외부 버튼(되돌리기/업로드 등) 과 같은 레벨에
 * 컨트롤 배치 가능, 줌·페이지 이동을 prop/이벤트로 제어 가능.
 *
 * 화질 — 줌 변경 시 CSS transform 이 아니라 캔버스를 새 해상도(scale × DPR) 로
 * 다시 그려서 어떤 배율에서도 흐림 없음. DPR_CAP 은 메모리 폭주 방지용.
 *
 * 메인 스레드 — PDF 파싱은 worker 가 처리, 캔버스 드로잉은 main 에서 발생(이건
 * PDF.js 구조상 불가피). 로딩 오버레이에 pointer-events:none 을 줘서 그리는
 * 동안에도 컨트롤 클릭은 큐에 안 쌓이고, 메인 스레드가 자유로워지는 즉시 처리.
 */
export default function PdfViewer({ url }) {
    const stageRef = useRef(null);
    const [stageWidth, setStageWidth] = useState(0);

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1);

    const [docLoading, setDocLoading] = useState(true);
    const [pageRendering, setPageRendering] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const measure = () => {
            if (stageRef.current) setStageWidth(stageRef.current.clientWidth);
        };
        measure();
        const ro = new ResizeObserver(measure);
        if (stageRef.current) ro.observe(stageRef.current);
        window.addEventListener('resize', measure);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, []);

    // url 바뀌면 상태 리셋
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

            <div className="pv-stage" ref={stageRef}>
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
