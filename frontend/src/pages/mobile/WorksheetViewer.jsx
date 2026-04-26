import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetViewer.css';

// Vite ?url import 으로 PDF.js worker 를 정적 자산으로 번들. CDN 의존 X.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부'];
const MAX_DEPT_LEN = 100;
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;

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
    const containerRef = useRef(null);

    const [detail, setDetail] = useState(null);
    const [detailError, setDetailError] = useState('');
    const [loadingDetail, setLoadingDetail] = useState(true);

    const [numPages, setNumPages] = useState(0);
    const [pdfError, setPdfError] = useState('');
    const [pageWidth, setPageWidth] = useState(0);

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

    // 컨테이너 폭 측정 → PDF 페이지 폭 = 화면 폭
    useEffect(() => {
        const measure = () => {
            if (!containerRef.current) return;
            // 좌우 8px 패딩 빼고 꽉 채우기
            const w = containerRef.current.clientWidth - 16;
            setPageWidth(Math.max(280, w));
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('orientationchange', measure);
        return () => {
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

    // R2 직접 URL 대신 백엔드 프록시 — R2 CORS 미설정 환경에서도 PDF.js 가 fetch 가능.
    const pdfFile = useMemo(() => {
        if (!detail?.worksheetPdfUrl || !orderNumber) return null;
        return { url: `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}/pdf` };
    }, [detail, orderNumber]);

    const onDocLoad = useCallback(({ numPages: n }) => {
        setNumPages(n);
        setPdfError('');
    }, []);
    const onDocError = useCallback((err) => {
        setPdfError(err?.message || 'PDF 를 표시할 수 없습니다.');
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
        <div className="wsv-page" ref={containerRef}>
            <header className="wsv-topbar">
                <Link to="/m/worksheets" className="wsv-back" aria-label="뒤로">‹</Link>
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
                onClick={() => {
                    // PDF 영역 단일 탭 → 시트 토글. 핀치/팬 도중에는 click 이벤트가 발생하지 않음.
                    if (!sheetOpen) setSheetOpen(true);
                }}
            >
                {loadingDetail && <div className="wsv-msg">불러오는 중…</div>}
                {!loadingDetail && detailError && <div className="wsv-msg error">{detailError}</div>}
                {!loadingDetail && !detailError && !pdfFile && (
                    <div className="wsv-msg">PDF 가 아직 등록되지 않았습니다.</div>
                )}
                {pdfFile && pageWidth > 0 && (
                    <TransformWrapper
                        initialScale={1}
                        minScale={1}
                        maxScale={5}
                        doubleClick={{ mode: 'toggle', step: 1.5 }}
                        wheel={{ step: 0.2 }}
                        pinch={{ step: 5 }}
                        panning={{ velocityDisabled: true }}
                    >
                        <TransformComponent
                            wrapperClass="wsv-tc-wrapper"
                            contentClass="wsv-tc-content"
                        >
                            <Document
                                file={pdfFile}
                                onLoadSuccess={onDocLoad}
                                onLoadError={onDocError}
                                loading={<div className="wsv-msg">PDF 불러오는 중…</div>}
                                error={<div className="wsv-msg error">PDF 표시 실패</div>}
                                noData={<div className="wsv-msg">PDF 가 비어있습니다.</div>}
                            >
                                {Array.from({ length: numPages }, (_, i) => (
                                    <Page
                                        key={i}
                                        pageNumber={i + 1}
                                        width={pageWidth}
                                        renderAnnotationLayer={false}
                                        renderTextLayer={false}
                                        className="wsv-page-canvas"
                                    />
                                ))}
                            </Document>
                        </TransformComponent>
                    </TransformWrapper>
                )}
                {pdfError && <div className="wsv-msg error">{pdfError}</div>}
            </div>

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
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            multiple
                            onChange={handlePickFiles}
                            style={{ display: 'none' }}
                        />

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
