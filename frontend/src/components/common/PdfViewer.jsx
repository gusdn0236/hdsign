import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfjs } from 'react-pdf';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './PdfViewer.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// 뷰포트(보이는 영역만) 렌더 방식 — 페이지 전체를 한 장의 거대한 캔버스에 굽지 않고,
// 화면 크기 캔버스에 "현재 보이는 창"만 그때그때 고해상으로 다시 그린다(지도 앱과 동일).
//  - 캔버스가 항상 화면 크기라 브라우저 캔버스 한계(한 변 16384px·면적 ~268M px)를 절대 안 넘음
//    → 아무리 확대해도 "Aw Snap"/깨짐 없음, 메모리도 화면 한 장 분량이라 가볍고 빠름.
//  - 확대(zoom)는 viewport scale 에 곱해져 들어가므로 고배율에서도 선명.
//  - 더블버퍼(offscreen→drawImage)라 다시 그리는 동안 직전 화면이 유지돼 깜빡임이 없다.
const MIN_SCALE = 1; // 1 = 화면에 페이지 전체가 들어오는 배율(fit)
const MAX_SCALE = 20; // 뷰포트 렌더라 깊게 확대해도 안전
const ZOOM_STEP = 1.2; // 휠/버튼 1틱 배율(곱셈)
const DPR_CAP = 2.5; // 렌더 선명도 상한(화면 캔버스라 2.5 면 충분)
const PAD = 16; // fit 시 페이지 둘레 여백(px)
const BG = '#1a1d24'; // 페이지 바깥 영역 색(pv-wrap 과 동일)

export default function PdfViewer({ url, onPageSize }) {
    // 첫 페이지 크기(pt)를 1회 부모에 알린다 — 새 창 뷰어가 창을 그 비율에 맞게 키울 때 쓴다.
    const onPageSizeRef = useRef(onPageSize);
    onPageSizeRef.current = onPageSize;
    const sizeReportedRef = useRef(false);

    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const offscreenRef = useRef(null); // 더블버퍼

    const docRef = useRef(null); // pdfjs 문서
    const pageRef = useRef(null); // 현재 페이지 객체
    const page0Ref = useRef({ w: 0, h: 0 }); // scale=1 일 때 페이지 크기(pt)
    const fitRef = useRef(1); // 페이지를 stage 에 맞추는 배율(CSS px/pt)
    const zoomRef = useRef(1); // fit 위에 곱하는 줌
    const offsetRef = useRef({ x: 0, y: 0 }); // 보이는 창의 좌상단(줌 적용된 페이지-CSS 좌표)

    // 렌더 직렬화 — 그리는 중 새 요청이 오면 끝나고 한 번 더(dirty).
    const drawingRef = useRef(false);
    const dirtyRef = useRef(false);
    const rafRef = useRef(0);

    const readyRef = useRef(false); // 첫 페이지 렌더 완료(콜백 안정화를 위해 ref)

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [zoomLabel, setZoomLabel] = useState(1);
    const [docLoading, setDocLoading] = useState(true);
    const [ready, setReady] = useState(false); // 첫 페이지 렌더 완료(스피너용)
    const [error, setError] = useState('');

    // ---- 한 프레임 렌더 ----------------------------------------------------
    const drawOnce = useCallback(async () => {
        const page = pageRef.current;
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        if (!page || !stage || !canvas) return;

        const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
        const cw = stage.clientWidth;
        const ch = stage.clientHeight;
        if (cw <= 0 || ch <= 0) return;

        const bw = Math.round(cw * dpr);
        const bh = Math.round(ch * dpr);

        // 화면(visible) 캔버스 크기 맞추기.
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';

        // 더블버퍼(offscreen) 준비.
        let off = offscreenRef.current;
        if (!off) {
            off = document.createElement('canvas');
            offscreenRef.current = off;
        }
        if (off.width !== bw || off.height !== bh) {
            off.width = bw;
            off.height = bh;
        }

        // 오프셋 클램프(페이지 밖으로 못 나가게, 작으면 가운데).
        const z = zoomRef.current;
        const fit = fitRef.current;
        const PW = page0Ref.current.w * fit * z; // 줌 적용 페이지 CSS 폭
        const PH = page0Ref.current.h * fit * z;
        let ox = offsetRef.current.x;
        let oy = offsetRef.current.y;
        ox = PW <= cw ? (PW - cw) / 2 : Math.min(Math.max(ox, 0), PW - cw);
        oy = PH <= ch ? (PH - ch) / 2 : Math.min(Math.max(oy, 0), PH - ch);
        offsetRef.current = { x: ox, y: oy };

        // pdf 좌표 → device px 배율. 보이는 창만 그리도록 translate 로 밀어 넣는다.
        const renderScale = fit * z * dpr;
        const viewport = page.getViewport({ scale: renderScale });
        const pageLeft = -ox * dpr; // 캔버스(=창) 안에서 페이지 좌상단 위치(device px)
        const pageTop = -oy * dpr;

        const octx = off.getContext('2d');
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.fillStyle = BG; // 페이지 바깥은 뷰어 배경색
        octx.fillRect(0, 0, bw, bh);
        octx.fillStyle = '#fff'; // 페이지 영역 흰 바탕(투명 PDF 대비)
        octx.fillRect(pageLeft, pageTop, PW * dpr, PH * dpr);

        let task;
        try {
            task = page.render({
                canvasContext: octx,
                viewport,
                transform: [1, 0, 0, 1, pageLeft, pageTop],
            });
            await task.promise;
        } catch (e) {
            if (e && e.name === 'RenderingCancelledException') return;
            throw e;
        }

        // 다 그려졌으면 한 번에 화면으로(깜빡임 없음).
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(off, 0, 0);
        if (!readyRef.current) {
            readyRef.current = true;
            setReady(true);
        }
    }, []);

    // 렌더 직렬화 — 그리는 중 들어온 요청은 dirty 로 모았다 끝나고 한 번 더.
    const runDraw = useCallback(async () => {
        if (drawingRef.current) {
            dirtyRef.current = true;
            return;
        }
        drawingRef.current = true;
        try {
            do {
                dirtyRef.current = false;
                await drawOnce();
            } while (dirtyRef.current);
        } catch (e) {
            setError(e?.message || 'PDF 페이지를 그릴 수 없습니다.');
        } finally {
            drawingRef.current = false;
        }
    }, [drawOnce]);

    const scheduleDraw = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            runDraw();
        });
    }, [runDraw]);

    // ---- 문서 로드 --------------------------------------------------------
    useEffect(() => {
        let alive = true;
        setDocLoading(true);
        setReady(false);
        readyRef.current = false;
        setError('');
        setNumPages(0);
        setCurrentPage(1);
        sizeReportedRef.current = false;
        zoomRef.current = 1;
        offsetRef.current = { x: 0, y: 0 };
        setZoomLabel(1);

        const task = pdfjs.getDocument(url);
        task.promise.then(
            (doc) => {
                if (!alive) {
                    doc.destroy?.();
                    return;
                }
                docRef.current = doc;
                setNumPages(doc.numPages);
                setDocLoading(false);
            },
            (err) => {
                if (!alive) return;
                setDocLoading(false);
                setError(err?.message || 'PDF 를 표시할 수 없습니다.');
            },
        );
        return () => {
            alive = false;
            try {
                task.destroy?.();
            } catch {
                /* noop */
            }
            const d = docRef.current;
            docRef.current = null;
            pageRef.current = null;
            try {
                d?.destroy?.();
            } catch {
                /* noop */
            }
        };
    }, [url]);

    // fit 배율을 stage 크기·페이지 크기로 재계산. 줌은 유지하되 오프셋을 새 fit 비율로 보정.
    const recomputeFit = useCallback(() => {
        const stage = stageRef.current;
        if (!stage || !page0Ref.current.w) return;
        const cw = Math.max(0, stage.clientWidth - PAD * 2);
        const ch = Math.max(0, stage.clientHeight - PAD * 2);
        const oldFit = fitRef.current || 1;
        const nf = Math.min(cw / page0Ref.current.w, ch / page0Ref.current.h) || 1;
        const ratio = nf / oldFit;
        fitRef.current = nf;
        offsetRef.current = { x: offsetRef.current.x * ratio, y: offsetRef.current.y * ratio };
    }, []);

    // ---- 페이지 로드(문서/페이지번호 바뀔 때) -------------------------------
    useEffect(() => {
        const doc = docRef.current;
        if (!doc || numPages === 0) return;
        let alive = true;
        const n = Math.min(Math.max(1, currentPage), doc.numPages);
        doc.getPage(n).then((page) => {
            if (!alive) return;
            pageRef.current = page;
            const vp = page.getViewport({ scale: 1 });
            page0Ref.current = { w: vp.width, h: vp.height };
            // 첫 페이지 크기를 1회 부모에 알림(창 비율 맞춤용).
            if (!sizeReportedRef.current) {
                sizeReportedRef.current = true;
                onPageSizeRef.current?.(vp.width, vp.height);
            }
            // 페이지가 바뀌면 fit(전체보기)로 초기화.
            zoomRef.current = 1;
            offsetRef.current = { x: 0, y: 0 };
            fitRef.current = 1;
            setZoomLabel(1);
            recomputeFit();
            scheduleDraw();
        });
        return () => {
            alive = false;
        };
        // numPages 가 0→N 으로 바뀐 직후 + currentPage 변경 시 재실행.
    }, [numPages, currentPage, recomputeFit, scheduleDraw]);

    // ---- stage 리사이즈 → fit 재계산 + 재렌더 -----------------------------
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const ro = new ResizeObserver(() => {
            recomputeFit();
            scheduleDraw();
        });
        ro.observe(stage);
        return () => ro.disconnect();
    }, [recomputeFit, scheduleDraw]);

    // ---- 줌(앵커 보존) ----------------------------------------------------
    const zoomTo = useCallback(
        (nextZoom, anchorClientX, anchorClientY) => {
            const stage = stageRef.current;
            if (!stage) return;
            const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextZoom));
            const old = zoomRef.current;
            if (clamped === old) return;

            const rect = stage.getBoundingClientRect();
            const mx = anchorClientX != null ? anchorClientX - rect.left : stage.clientWidth / 2;
            const my = anchorClientY != null ? anchorClientY - rect.top : stage.clientHeight / 2;

            // 커서 아래 페이지-CSS 좌표가 줌 후에도 같은 화면 위치에 오도록 오프셋 보정.
            const f = clamped / old;
            offsetRef.current = {
                x: (offsetRef.current.x + mx) * f - mx,
                y: (offsetRef.current.y + my) * f - my,
            };
            zoomRef.current = clamped;
            setZoomLabel(clamped);
            scheduleDraw();
        },
        [scheduleDraw],
    );

    const zoomIn = useCallback(() => zoomTo(zoomRef.current * ZOOM_STEP), [zoomTo]);
    const zoomOut = useCallback(() => zoomTo(zoomRef.current / ZOOM_STEP), [zoomTo]);
    const zoomReset = useCallback(() => {
        zoomRef.current = 1;
        offsetRef.current = { x: 0, y: 0 };
        setZoomLabel(1);
        scheduleDraw();
    }, [scheduleDraw]);

    // 휠 = 줌(커서 앵커). native 리스너 + passive:false 로 preventDefault.
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (e) => {
            e.preventDefault();
            const f = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            zoomTo(zoomRef.current * f, e.clientX, e.clientY);
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
    }, [zoomTo]);

    // 드래그 = 이동(팬).
    const onPanStart = useCallback(
        (e) => {
            if (e.button !== 0) return;
            const startX = e.clientX;
            const startY = e.clientY;
            const o0 = { ...offsetRef.current };
            const stage = stageRef.current;
            stage?.classList.add('pv-stage--panning');
            e.preventDefault();
            const onMove = (ev) => {
                offsetRef.current = { x: o0.x - (ev.clientX - startX), y: o0.y - (ev.clientY - startY) };
                scheduleDraw();
            };
            const onUp = () => {
                stage?.classList.remove('pv-stage--panning');
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [scheduleDraw],
    );

    useEffect(
        () => () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        },
        [],
    );

    return (
        <div className="pv-wrap">
            <div className="pv-controls">
                <button type="button" onClick={zoomOut} disabled={zoomLabel <= MIN_SCALE} className="pv-btn" aria-label="축소">
                    －
                </button>
                <span className="pv-scale">{Math.round(zoomLabel * 100)}%</span>
                <button type="button" onClick={zoomIn} disabled={zoomLabel >= MAX_SCALE} className="pv-btn" aria-label="확대">
                    ＋
                </button>
                <button type="button" onClick={zoomReset} className="pv-btn pv-btn-ghost">
                    원래대로
                </button>

                <span className="pv-hint">휠 확대/축소 · 드래그 이동</span>

                {numPages > 1 && (
                    <div className="pv-pager">
                        <button
                            type="button"
                            className="pv-btn"
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            disabled={currentPage <= 1}
                            aria-label="이전 페이지"
                        >
                            ‹
                        </button>
                        <span className="pv-pager-text">
                            {currentPage} / {numPages}
                        </span>
                        <button
                            type="button"
                            className="pv-btn"
                            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                            disabled={currentPage >= numPages}
                            aria-label="다음 페이지"
                        >
                            ›
                        </button>
                    </div>
                )}
            </div>

            <div className="pv-stage" ref={stageRef} onMouseDown={onPanStart}>
                <canvas ref={canvasRef} className="pv-canvas" />

                {(docLoading || !ready) && !error && (
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
