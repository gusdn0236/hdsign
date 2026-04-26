import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetViewer.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부'];
const MAX_DEPT_LEN = 100;
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;
const DEFAULT_PAGE_RATIO = 1 / Math.sqrt(2);

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
    const [department, setDepartment] = useState(() => getStoredDept());
    const [showDeptModal, setShowDeptModal] = useState(false);
    const [deptDraft, setDeptDraft] = useState('');
    const [queued, setQueued] = useState([]);
    const [compressing, setCompressing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [uploadError, setUploadError] = useState('');
    const [pdfViewKey, setPdfViewKey] = useState(0);
    // 화질 점진 향상 — TransformWrapper.onTransformed 로 현재 핀치 줌 스케일 추적,
    // 디바운스 후 renderScale 갱신 → Page 재렌더(devicePixelRatio 가 scale 배수로).
    // 줌 안 했을 땐 base DPR 로 빠르게, 줌하면 글씨 또렷해지게.
    const [renderScale, setRenderScale] = useState(1);
    const transformRef = useRef(null);
    const renderScaleTimerRef = useRef(null);

    const resetPdfView = useCallback((e) => {
        e?.stopPropagation?.();
        if (transformRef.current?.resetTransform) {
            transformRef.current.resetTransform(0);
            setRenderScale(1);
            return;
        }
        setPdfReady(false);
        setPdfViewKey((key) => key + 1);
    }, []);

    const handleTransformed = useCallback((_ref, state) => {
        if (renderScaleTimerRef.current) clearTimeout(renderScaleTimerRef.current);
        renderScaleTimerRef.current = setTimeout(() => {
            setRenderScale((prev) => {
                const next = Math.max(1, Math.min(5, state.scale || 1));
                return Math.abs(next - prev) > 0.05 ? next : prev;
            });
        }, 280);
    }, []);

    useEffect(() => () => {
        if (renderScaleTimerRef.current) clearTimeout(renderScaleTimerRef.current);
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

    // 주문 상세
    useEffect(() => {
        if (!orderNumber) return;
        let alive = true;
        setLoadingDetail(true);
        fetch(`${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.message || '지시서 정보를 가져오지 못했습니다.');
                }
                return res.json();
            })
            .then((data) => {
                if (!alive) return;
                setDetail(data);
                setDetailError('');
            })
            .catch((err) => {
                if (!alive) return;
                setDetailError(err.message || '오류가 발생했습니다.');
            })
            .finally(() => alive && setLoadingDetail(false));
        return () => { alive = false; };
    }, [orderNumber]);

    // 미리보기 URL revoke
    useEffect(() => () => {
        queued.forEach((q) => URL.revokeObjectURL(q.previewUrl));
    }, [queued]);

    const pdfFile = useMemo(
        () => (detail?.worksheetPdfUrl ? { url: detail.worksheetPdfUrl } : null),
        [detail],
    );

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
                <a
                    href="/m/worksheets"
                    className="wsv-back"
                    aria-label="뒤로"
                >‹</a>
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

            <div
                className="wsv-stage"
                ref={stageRef}
                onClick={() => {
                    if (!sheetOpen) setSheetOpen(true);
                }}
            >
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
                        doubleClick={{ mode: 'toggle', step: 1.4 }}
                        wheel={{ step: 0.18 }}
                        pinch={{ step: 5 }}
                        panning={{ velocityDisabled: true }}
                        onTransformed={handleTransformed}
                    >
                        <TransformComponent
                            wrapperClass="wsv-pdf-wrapper"
                            contentClass="wsv-pdf-content"
                        >
                            <Document
                                file={pdfFile}
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
                                        // 줌 안 한 상태에선 DPR 3 으로 빠르게, 핀치줌하면 디바운스 후
                                        // renderScale 이 올라가며 DPR 도 비례 증가(상한 8) → 글씨 선명.
                                        devicePixelRatio={Math.min(8, Math.max(3, Math.ceil(3 * renderScale)))}
                                        renderAnnotationLayer={false}
                                        renderTextLayer={false}
                                        onLoadSuccess={onPageLoad}
                                        onRenderSuccess={() => {
                                            setPdfReady(true);
                                            // Page 가 실제로 그려진 직후 한 번 더 가운데 정렬 — centerOnInit
                                            // 이 빈 콘텐츠 기준으로 계산돼 어긋나는 케이스 방지.
                                            requestAnimationFrame(() => {
                                                transformRef.current?.resetTransform?.(0);
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
                        >‹</button>
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
                        >›</button>
                    </div>
                )}
            </div>

            <div className="wsv-actionbar">
                <button
                    type="button"
                    className="wsv-action-reset"
                    onClick={resetPdfView}
                >
                    ⟲ 전체보기
                </button>
                <button
                    type="button"
                    className="wsv-action-camera"
                    onClick={() => setSheetOpen(true)}
                    aria-label="사진찍기"
                >
                    <span className="wsv-action-camera-emoji" aria-hidden="true">📷</span>
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
                            >×</button>
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
                            {compressing ? '사진 처리 중…' : '📷 사진 찍기 / 선택하기'}
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
                                            >×</button>
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
                                ✓ {uploadResult.count}장 업로드 완료
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
