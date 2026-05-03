import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetViewer.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부', '후레임부'];
const MAX_DEPT_LEN = 100;
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;
const DEFAULT_PAGE_RATIO = 1 / Math.sqrt(2);
// PDF 렌더 DPR — 처음 한 번에 핀치 최대줌까지 견디는 고해상도로 그린다.
// 옛날엔 빠른 저화질 → idle 후 고화질 재렌더 였는데, 화면이 하얗게 깜빡이는 게
// 오히려 거슬려서 단계 향상 제거. 면적 캡은 모바일 캔버스 한계 안전선.
const PDF_BASE_DPR = 3;
const PDF_MAX_DPR = 14;
const PDF_OVERSAMPLE = 1.15;
const PDF_MAX_CANVAS_PIXELS = 32_000_000;
const PDF_JS_MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const PINCH_MAX_SCALE = 5;

async function compressImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        return file;
    }
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const scale = longest > COMPRESS_MAX_DIM ? COMPRESS_MAX_DIM / longest : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        bitmap.close?.();
        return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const baseName = (file.name || 'photo').replace(/\.[^/.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}

function getStoredDept() {
    try {
        const v = localStorage.getItem(DEPT_KEY);
        return v ? v.trim() : '';
    } catch {
        return '';
    }
}
function setStoredDept(value) {
    try {
        if (value) localStorage.setItem(DEPT_KEY, value);
        else localStorage.removeItem(DEPT_KEY);
    } catch { /* ignore */ }
}

const DELIVERY_LABELS = {
    CARGO: '화물', QUICK: '퀵', DIRECT: '직접배송', PICKUP: '직접수령', LOCAL_CARGO: '용달',
};

export default function WorksheetViewer() {
    const { orderNumber } = useParams();
    const navigate = useNavigate();
    const fileInputRef = useRef(null);
    const stageRef = useRef(null);

    const [detail, setDetail] = useState(null);
    const [detailError, setDetailError] = useState('');
    const [loadingDetail, setLoadingDetail] = useState(true);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageRatio, setPageRatio] = useState(DEFAULT_PAGE_RATIO);
    const [pdfReady, setPdfReady] = useState(false);
    const [pdfError, setPdfError] = useState('');

    // 시트 (탭하면 열림)
    const [sheetOpen, setSheetOpen] = useState(false);
    // PDF 한 번 탭 → 변경사항 카드 토글. 더블탭(줌 토글)과 충돌 막으려고 280ms 디바운스.
    const [changeNoteVisible, setChangeNoteVisible] = useState(false);
    const stageTapTimerRef = useRef(null);
    const [department, setDepartment] = useState(() => getStoredDept());
    const [showDeptModal, setShowDeptModal] = useState(false);
    const [deptDraft, setDeptDraft] = useState('');
    const [queued, setQueued] = useState([]);
    const [compressing, setCompressing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [uploadError, setUploadError] = useState('');
    const [pdfViewKey, setPdfViewKey] = useState(0);
    const transformRef = useRef(null);

    const resetPdfView = useCallback((e) => {
        e?.stopPropagation?.();
        if (transformRef.current?.resetTransform) {
            transformRef.current.resetTransform(0);
            return;
        }
        setPdfReady(false);
        setPdfViewKey((key) => key + 1);
    }, []);

    useEffect(() => () => {
        if (stageTapTimerRef.current) clearTimeout(stageTapTimerRef.current);
    }, []);

    // PDF 영역 한 번 탭 → 변경사항/추가요청사항 오버레이 토글.
    // react-zoom-pan-pinch 가 패닝/핀치 중에는 click 합성을 막아주므로 여기엔 단순 탭만 들어온다.
    // 더블탭(줌 토글) 과 충돌하지 않도록 280ms 디바운스: 두 번째 탭이 빠르게 오면 단발 탭 액션은
    // 취소(=라이브러리가 doubleClick 줌으로 처리하도록 양보).
    const handleStageTap = useCallback((e) => {
        // 페이저 등 자체 핸들러가 있는 자식은 stopPropagation 으로 이미 차단됨.
        if (e?.target instanceof Element) {
            const t = e.target;
            // wsv-msg(불러오는 중 텍스트)나 페이저 영역이면 무시.
            if (t.closest('.wsv-pager')) return;
        }
        if (stageTapTimerRef.current) {
            clearTimeout(stageTapTimerRef.current);
            stageTapTimerRef.current = null;
            return;
        }
        stageTapTimerRef.current = setTimeout(() => {
            stageTapTimerRef.current = null;
            setChangeNoteVisible((v) => !v);
        }, 280);
    }, []);

    // iOS PWA standalone 에서 click 이벤트가 안 발사되는 케이스를 보강.
    // touchend 시점에 액션을 즉시 트리거하고 후속 synthetic click 은 preventDefault
    // 로 막아 중복 발사 방지. 데스크톱(터치 없는 환경) 에선 평범하게 onClick 만 발사.
    const tapHandler = useCallback((action) => (e) => {
        e.preventDefault();
        action(e);
    }, []);

    // 브라우저 페이지 줌은 막고, PDF 자체만 TransformWrapper 로 확대/이동한다.
    useEffect(() => {
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return undefined;
        const original = meta.getAttribute('content') || '';
        meta.setAttribute(
            'content',
            'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
        );
        return () => meta.setAttribute('content', original);
    }, []);

    useEffect(() => {
        const measure = () => {
            if (!stageRef.current) return;
            const rect = stageRef.current.getBoundingClientRect();
            setStageSize({
                width: Math.max(0, Math.floor(rect.width)),
                height: Math.max(0, Math.floor(rect.height)),
            });
        };
        measure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        if (observer && stageRef.current) observer.observe(stageRef.current);
        window.addEventListener('resize', measure);
        window.addEventListener('orientationchange', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            window.removeEventListener('orientationchange', measure);
        };
    }, []);

    // 주문 상세 — 캐시버스터(_) + cache:'no-store' 로 워처가 방금 저장한 worksheetChangeNote
    // 등이 모바일/CDN 캐시 때문에 옛 값으로 보이는 문제 방지. 백→포(visibilitychange) /
    // 창 포커스 복귀에도 재조회 — 작업자가 뷰어를 띄워둔 상태에서 워처가 업데이트해도 곧 갱신.
    useEffect(() => {
        if (!orderNumber) return;
        let alive = true;
        const aliveCheck = () => alive;

        const fetchDetail = async ({ initial = false } = {}) => {
            if (initial) setLoadingDetail(true);
            try {
                const res = await fetch(
                    `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}?_=${Date.now()}`,
                    { cache: 'no-store' },
                );
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.message || '지시서 정보를 가져오지 못했습니다.');
                }
                const data = await res.json();
                if (!aliveCheck()) return;
                setDetail(data);
                setDetailError('');
            } catch (err) {
                if (!aliveCheck()) return;
                if (initial) setDetailError(err.message || '오류가 발생했습니다.');
            } finally {
                if (initial && aliveCheck()) setLoadingDetail(false);
            }
        };

        fetchDetail({ initial: true });

        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchDetail();
        };
        const onFocus = () => fetchDetail();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);

        return () => {
            alive = false;
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
        };
    }, [orderNumber]);

    // 미리보기 URL revoke
    useEffect(() => () => {
        queued.forEach((q) => URL.revokeObjectURL(q.previewUrl));
    }, [queued]);

    const pdfFile = useMemo(() => {
        if (!detail?.worksheetPdfUrl || !orderNumber) return null;
        const version = detail.worksheetUpdatedAt || detail.worksheetPdfUrl;
        return {
            url: `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}/pdf?v=${encodeURIComponent(version)}`,
        };
    }, [detail?.worksheetPdfUrl, detail?.worksheetUpdatedAt, orderNumber]);

    const pdfOptions = useMemo(() => ({
        canvasMaxAreaInBytes: PDF_JS_MAX_IMAGE_BYTES,
        disableFontFace: false,
        isOffscreenCanvasSupported: true,
        useSystemFonts: true,
    }), []);

    useEffect(() => {
        setNumPages(0);
        setCurrentPage(1);
        setPageRatio(DEFAULT_PAGE_RATIO);
        setPdfReady(false);
        setPdfError('');
        setPdfViewKey((key) => key + 1);
    }, [detail?.worksheetPdfUrl]);

    const pageWidth = useMemo(() => {
        if (!stageSize.width || !stageSize.height) return 0;
        const padding = 16;
        const maxWidth = Math.max(260, stageSize.width - padding);
        const maxHeight = Math.max(260, stageSize.height - padding);
        return Math.floor(Math.min(maxWidth, maxHeight * pageRatio));
    }, [pageRatio, stageSize.height, stageSize.width]);

    // PDF 가 처음 그려진 후라도 stage 크기/페이지 비율/페이지 폭이 비동기로 늦게 도착하면
    // 라이브러리의 transform 좌표가 옛 크기 기준에 머물러 한쪽으로 치우친 채 보일 수 있다.
    // (모바일 회전, 화면 가상키보드 닫힘, onPageLoad 의 pageRatio 후속 갱신 등)
    // 사용자가 줌/이동을 하지 않은 상태(스케일 ≈ 1)일 때만 자동 가운데 재정렬 — 사용자가
    // 일부러 확대/패닝해둔 상태를 가로채지 않도록.
    useEffect(() => {
        if (!pdfReady || !pageWidth) return;
        const t = setTimeout(() => {
            const api = transformRef.current;
            if (!api) return;
            const currentScale = api.instance?.transformState?.scale ?? 1;
            if (currentScale > 1.05) return;
            api.resetTransform?.(0);
            api.centerView?.(1, 0);
        }, 60);
        return () => clearTimeout(t);
    }, [pdfReady, pageWidth, stageSize.width, stageSize.height]);

    const pdfDevicePixelRatio = useMemo(() => {
        const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const pageHeight = pageRatio > 0 ? pageWidth / pageRatio : 0;
        const cssPixels = pageWidth > 0 && pageHeight > 0 ? pageWidth * pageHeight : 0;
        const areaLimitedDpr = cssPixels > 0
            ? Math.sqrt(PDF_MAX_CANVAS_PIXELS / cssPixels)
            : PDF_MAX_DPR;
        const cap = Math.max(PDF_BASE_DPR, Math.min(PDF_MAX_DPR, areaLimitedDpr));

        // 핀치 최대줌(PINCH_MAX_SCALE) 에서도 글자 획이 뭉개지지 않도록 약간 과샘플링한다.
        return Math.min(cap, Math.max(PDF_BASE_DPR, deviceDpr * PINCH_MAX_SCALE * PDF_OVERSAMPLE));
    }, [pageRatio, pageWidth]);

    const onDocLoad = useCallback(({ numPages: n }) => {
        setNumPages(n);
        setCurrentPage((page) => Math.min(Math.max(1, page), n || 1));
        setPdfError('');
    }, []);

    const onDocError = useCallback((err) => {
        setPdfError(err?.message || 'PDF 를 표시할 수 없습니다.');
    }, []);

    const onPageLoad = useCallback((page) => {
        const viewport = page.getViewport({ scale: 1 });
        if (viewport?.width && viewport?.height) {
            const nextRatio = viewport.width / viewport.height;
            setPageRatio((currentRatio) => (
                Math.abs(currentRatio - nextRatio) > 0.001 ? nextRatio : currentRatio
            ));
        }
    }, []);

    const handlePickFiles = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setCompressing(true);
        setUploadResult(null);
        setUploadError('');
        const processed = [];
        for (const file of files) {
            let f = file;
            try { f = await compressImage(file); } catch { f = file; }
            processed.push({ file: f, previewUrl: URL.createObjectURL(f) });
        }
        setQueued((prev) => [...prev, ...processed]);
        setSheetOpen(true);
        setCompressing(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removeQueued = (idx) => {
        setQueued((prev) => {
            const next = [...prev];
            const [removed] = next.splice(idx, 1);
            if (removed) URL.revokeObjectURL(removed.previewUrl);
            return next;
        });
    };

    const triggerCamera = () => {
        if (compressing || uploading) return;
        if (!department) {
            setDeptDraft('');
            setShowDeptModal(true);
            return;
        }
        fileInputRef.current?.click();
    };

    const handleUpload = async () => {
        if (!queued.length || uploading) return;
        if (!department) {
            setDeptDraft('');
            setShowDeptModal(true);
            return;
        }
        setUploading(true);
        setUploadError('');
        setUploadResult(null);
        try {
            const fd = new FormData();
            fd.append('department', department);
            queued.forEach((q) => fd.append('files', q.file, q.file.name));
            const res = await fetch(
                `${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/evidence`,
                { method: 'POST', body: fd }
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || '업로드에 실패했습니다.');
            }
            const body = await res.json();
            queued.forEach((q) => URL.revokeObjectURL(q.previewUrl));
            setQueued([]);
            setUploadResult({ count: body.count || 0 });
        } catch (err) {
            setUploadError(err.message || '업로드 중 오류');
        } finally {
            setUploading(false);
        }
    };

    const submitDept = () => {
        const v = (deptDraft || '').trim().slice(0, MAX_DEPT_LEN);
        if (!v) return;
        setDepartment(v);
        setStoredDept(v);
        setShowDeptModal(false);
    };
    const openChangeDept = () => {
        setDeptDraft(department || '');
        setShowDeptModal(true);
    };

    const totalSize = useMemo(
        () => queued.reduce((s, q) => s + (q.file?.size || 0), 0),
        [queued]
    );

    return (
        <div className="wsv-page">
            <header className="wsv-topbar">
                {/* Link + onClick 조합:
                    - PWA standalone 에서 평범한 <a href> 는 외부 사파리로 빠져나가는 케이스가
                      있어 React Router 의 SPA 내비게이션(pushState) 으로 처리해야 PWA 안에서
                      목록으로 이동.
                    - onClick 으로 navigate() 명시 호출 + Link 의 anchor href 가 fallback. */}
                <Link
                    to="/m/worksheets"
                    onClick={(e) => {
                        e.preventDefault();
                        navigate('/m/worksheets');
                    }}
                    onTouchEnd={tapHandler(() => navigate('/m/worksheets'))}
                    className="wsv-back"
                    aria-label="뒤로"
                >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12.5 4.5L7 10l5.5 5.5" />
                    </svg>
                </Link>
                <div className="wsv-topbar-text">
                    <div className="wsv-topbar-company">
                        {detail?.companyName || (loadingDetail ? '…' : '거래처 미상')}
                    </div>
                    <div className="wsv-topbar-title">
                        {detail?.title || orderNumber}
                    </div>
                </div>
                {detail?.dueDate && (
                    <div className="wsv-topbar-due">
                        납기 {detail.dueDate.slice(5).replace('-', '/')}
                        {detail.dueTime ? ` ${detail.dueTime}` : ''}
                    </div>
                )}
            </header>

            {/* stage onClick — PDF 영역 한 번 탭 → 변경사항/추가요청사항 오버레이 토글.
                옛 버전엔 stage 탭 = 업로드 시트 열기였으나 사진찍기 버튼으로 분리됐고,
                지금은 워처에서 작업자가 입력한 변경 메모를 즉석에서 띄우는 데 쓴다. */}
            <div className="wsv-stage" ref={stageRef} onClick={handleStageTap}>
                {loadingDetail && <div className="wsv-msg">불러오는 중…</div>}
                {!loadingDetail && detailError && <div className="wsv-msg error">{detailError}</div>}
                {!loadingDetail && !detailError && !pdfFile && (
                    <div className="wsv-msg">PDF 가 아직 등록되지 않았습니다.</div>
                )}
                {pdfFile && pageWidth > 0 && !pdfReady && !pdfError && (
                    <div className="wsv-msg wsv-pdf-loading">PDF 불러오는 중…</div>
                )}
                {pdfFile && pageWidth > 0 && (
                    <TransformWrapper
                        key={`pdf-view-${pdfViewKey}`}
                        ref={transformRef}
                        initialScale={1}
                        minScale={1}
                        maxScale={5}
                        centerOnInit
                        centerZoomedOut
                        doubleClick={{ mode: 'toggle', step: 1.4 }}
                        wheel={{
                            step: 0.18,
                            excluded: ['wsv-back', 'wsv-action-reset', 'wsv-action-camera'],
                        }}
                        pinch={{ step: 5 }}
                        panning={{
                            velocityDisabled: true,
                            // 라이브러리가 window mousedown 을 듣는데, 만에 하나 버튼 영역
                            // 탭이 흘러들어가면 preventDefault 가 click 합성을 막을 수 있음.
                            // 명시적으로 제외해 라이브러리가 절대 가로채지 못하게.
                            excluded: ['wsv-back', 'wsv-action-reset', 'wsv-action-camera',
                                       'wsv-action-reset-icon', 'wsv-action-reset-text',
                                       'wsv-action-camera-icon', 'wsv-action-camera-text',
                                       'wsv-pager-btn'],
                        }}
                    >
                        <TransformComponent
                            wrapperClass="wsv-pdf-wrapper"
                            contentClass="wsv-pdf-content"
                        >
                            <Document
                                file={pdfFile}
                                options={pdfOptions}
                                onLoadSuccess={onDocLoad}
                                onLoadError={onDocError}
                                loading={null}
                                error={<div className="wsv-msg error">PDF 표시 실패</div>}
                                noData={<div className="wsv-msg">PDF 가 비어있습니다.</div>}
                            >
                                {numPages > 0 && (
                                    <Page
                                        pageNumber={currentPage}
                                        width={pageWidth}
                                        // 핀치 최대줌까지 견디는 고해상도로 한 번만 렌더 — 단계 향상으로 인한 깜빡임 없음.
                                        devicePixelRatio={pdfDevicePixelRatio}
                                        renderAnnotationLayer={false}
                                        renderTextLayer={false}
                                        onLoadSuccess={onPageLoad}
                                        onRenderSuccess={() => {
                                            setPdfReady(true);
                                            // Page 가 실제로 그려진 직후 가운데 정렬 — centerOnInit 이 빈 콘텐츠
                                            // 기준으로 계산돼 어긋나는 케이스 방지. RAF 두 번(레이아웃 사이클 한 바퀴
                                            // 보장) 후 호출 — 첫 RAF 시점엔 onPageLoad 의 pageRatio 변경이 아직
                                            // 반영 안 됐을 수 있어 한쪽으로 치우치던 산발적 증상 잡음.
                                            // resetTransform 만 부르면 일부 케이스에서 변환 좌표(0,0) 만
                                            // 복원돼 가운데가 안 맞을 때가 있어 centerView 도 추가 호출.
                                            requestAnimationFrame(() => {
                                                requestAnimationFrame(() => {
                                                    const api = transformRef.current;
                                                    api?.resetTransform?.(0);
                                                    api?.centerView?.(1, 0);
                                                });
                                            });
                                        }}
                                        loading={null}
                                        className="wsv-page-canvas"
                                    />
                                )}
                            </Document>
                        </TransformComponent>
                    </TransformWrapper>
                )}
                {pdfError && <div className="wsv-msg error">{pdfError}</div>}

                {changeNoteVisible && (() => {
                    const note = (detail?.note || '').trim();
                    const items = (detail?.additionalItems || '').trim();
                    const change = (detail?.worksheetChangeNote || '').trim();
                    const dueDateLabel = (() => {
                        if (!change || !detail?.dueDate) return '';
                        const d = detail.dueDate;
                        // YYYY-MM-DD → "M월 D일" + 시간 있으면 추가.
                        const parts = d.split('-');
                        if (parts.length === 3) {
                            const m = parseInt(parts[1], 10);
                            const day = parseInt(parts[2], 10);
                            return `${m}월 ${day}일${detail.dueTime ? ` ${detail.dueTime}` : ''}`;
                        }
                        return d + (detail.dueTime ? ` ${detail.dueTime}` : '');
                    })();
                    const hasAny = note || items || change;
                    return (
                        <div className="wsv-change-overlay" aria-live="polite">
                            <div className="wsv-change-card">
                                {note && (
                                    <div className="wsv-change-section">
                                        <div className="wsv-change-key">거래처 추가요청사항</div>
                                        <div className="wsv-change-text">{note}</div>
                                    </div>
                                )}
                                {items && (
                                    <div className="wsv-change-section">
                                        <div className="wsv-change-key">추가물품</div>
                                        <div className="wsv-change-text">{items}</div>
                                    </div>
                                )}
                                {change && (
                                    <div className="wsv-change-section">
                                        <div className="wsv-change-key wsv-change-key-warn">변경사항</div>
                                        <div className="wsv-change-text">{change}</div>
                                    </div>
                                )}
                                {change && dueDateLabel && (
                                    <div className="wsv-change-section">
                                        <div className="wsv-change-key wsv-change-key-warn">납품날짜</div>
                                        <div className="wsv-change-text">{dueDateLabel}</div>
                                    </div>
                                )}
                                {!hasAny && (
                                    <div className="wsv-change-section">
                                        <div className="wsv-change-text wsv-change-empty">
                                            추가요청사항이 없습니다.
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })()}

                {numPages > 1 && (
                    <div className="wsv-pager" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="wsv-pager-btn"
                            onClick={() => {
                                setPdfReady(false);
                                setCurrentPage((p) => Math.max(1, p - 1));
                            }}
                            disabled={currentPage <= 1}
                            aria-label="이전 페이지"
                        >
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M11 4L6 9l5 5" />
                            </svg>
                        </button>
                        <span className="wsv-pager-text">{currentPage} / {numPages}</span>
                        <button
                            type="button"
                            className="wsv-pager-btn"
                            onClick={() => {
                                setPdfReady(false);
                                setCurrentPage((p) => Math.min(numPages, p + 1));
                            }}
                            disabled={currentPage >= numPages}
                            aria-label="다음 페이지"
                        >
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M7 4l5 5-5 5" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>

            <div className="wsv-actionbar">
                <button
                    type="button"
                    className="wsv-action-reset"
                    onClick={resetPdfView}
                    onTouchEnd={tapHandler(resetPdfView)}
                >
                    <span className="wsv-action-reset-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 7V3h4" />
                            <path d="M17 7V3h-4" />
                            <path d="M3 13v4h4" />
                            <path d="M17 13v4h-4" />
                        </svg>
                    </span>
                    <span className="wsv-action-reset-text">전체보기</span>
                </button>
                <button
                    type="button"
                    className="wsv-action-camera"
                    onClick={() => setSheetOpen(true)}
                    onTouchEnd={tapHandler(() => setSheetOpen(true))}
                    aria-label="사진찍기"
                >
                    <span className="wsv-action-camera-icon" aria-hidden="true">
                        <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 7.5h2.5l1.5-2h6l1.5 2H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4A1.5 1.5 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5z" />
                            <circle cx="11" cy="13" r="3.2" />
                        </svg>
                    </span>
                    <span className="wsv-action-camera-text">사진찍기</span>
                </button>
            </div>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={handlePickFiles}
                style={{ display: 'none' }}
            />

            {/* 바닥 시트 — 사진 업로드 */}
            {sheetOpen && (
                <div className="wsv-sheet-backdrop" onClick={() => setSheetOpen(false)}>
                    <div className="wsv-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="wsv-sheet-handle" />
                        <div className="wsv-sheet-head">
                            <div>
                                <div className="wsv-sheet-title">작업 사진 업로드</div>
                                <div className="wsv-sheet-sub">{orderNumber}</div>
                            </div>
                            <button
                                type="button"
                                className="wsv-sheet-close"
                                onClick={() => setSheetOpen(false)}
                                aria-label="닫기"
                            >
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M4 4l8 8M12 4l-8 8" />
                                </svg>
                            </button>
                        </div>

                        <div className="wsv-dept-row">
                            <span className="wsv-dept-label">촬영 부서</span>
                            <span className="wsv-dept-value">{department || '미설정'}</span>
                            <button type="button" className="wsv-dept-change" onClick={openChangeDept}>
                                변경
                            </button>
                        </div>

                        <button
                            type="button"
                            className="wsv-camera-btn"
                            onClick={triggerCamera}
                            disabled={uploading || compressing}
                        >
                            {compressing ? (
                                <span>사진 처리 중…</span>
                            ) : (
                                <>
                                    <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M4 7.5h2.5l1.5-2h6l1.5 2H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4A1.5 1.5 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5z" />
                                        <circle cx="11" cy="13" r="3.2" />
                                    </svg>
                                    <span>사진 찍기 / 선택하기</span>
                                </>
                            )}
                        </button>

                        {queued.length > 0 && (
                            <div className="wsv-queue">
                                <div className="wsv-queue-head">
                                    <span>{queued.length}장 선택됨</span>
                                    <span className="wsv-queue-size">{(totalSize / (1024 * 1024)).toFixed(1)} MB</span>
                                </div>
                                <div className="wsv-thumbs">
                                    {queued.map((q, idx) => (
                                        <div key={`${q.file.name}-${idx}`} className="wsv-thumb">
                                            <img src={q.previewUrl} alt="" />
                                            <button
                                                type="button"
                                                className="wsv-thumb-x"
                                                onClick={() => removeQueued(idx)}
                                                disabled={uploading}
                                                aria-label="삭제"
                                            >
                                                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                    <path d="M3 3l6 6M9 3l-6 6" />
                                                </svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    type="button"
                                    className="wsv-upload-btn"
                                    onClick={handleUpload}
                                    disabled={uploading}
                                >
                                    {uploading ? '업로드 중…' : `${queued.length}장 업로드`}
                                </button>
                            </div>
                        )}

                        {uploadError && <div className="wsv-feedback error">{uploadError}</div>}
                        {uploadResult && (
                            <div className="wsv-feedback success">
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M3 8l3.5 3.5L13 5" />
                                </svg>
                                <span>{uploadResult.count}장 업로드 완료</span>
                            </div>
                        )}

                        {detail?.deliveryMethod && (
                            <div className="wsv-info-line">
                                배송 · {DELIVERY_LABELS[detail.deliveryMethod] || detail.deliveryMethod}
                            </div>
                        )}
                        {detail?.note && (
                            <div className="wsv-info-block">
                                <div className="wsv-info-key">메모</div>
                                <div className="wsv-info-value">{detail.note}</div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {showDeptModal && (
                <div className="wsv-modal-backdrop" onClick={() => department && setShowDeptModal(false)}>
                    <div className="wsv-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>촬영 부서 입력</h2>
                        <p className="wsv-modal-desc">
                            이 휴대폰에서 올린 사진이 어느 부서에서 올린 건지 표시됩니다. 한 번만 입력하면 다음부터 자동 사용됩니다.
                        </p>
                        <div className="wsv-quick-chips">
                            {QUICK_DEPTS.map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    className={`wsv-chip ${deptDraft === d ? 'active' : ''}`}
                                    onClick={() => setDeptDraft(d)}
                                >{d}</button>
                            ))}
                        </div>
                        <input
                            type="text"
                            className="wsv-dept-input"
                            placeholder="직접 입력"
                            value={deptDraft}
                            maxLength={MAX_DEPT_LEN}
                            onChange={(e) => setDeptDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submitDept(); }}
                            autoFocus
                        />
                        <div className="wsv-modal-actions">
                            {department && (
                                <button
                                    type="button"
                                    className="wsv-modal-cancel"
                                    onClick={() => setShowDeptModal(false)}
                                >취소</button>
                            )}
                            <button
                                type="button"
                                className="wsv-modal-confirm"
                                onClick={submitDept}
                                disabled={!deptDraft.trim()}
                            >저장</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
