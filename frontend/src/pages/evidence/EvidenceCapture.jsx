import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import './EvidenceCapture.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부'];
const MAX_DEPT_LEN = 100;

// 카메라 원본은 보통 3~5MB+. 한 변 1600px / JPEG 0.82로 압축하면 200~500KB로 떨어진다.
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;

async function compressImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;

    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        return file; // HEIC 등 디코드 실패 시 원본 그대로
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

    const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY)
    );
    if (!blob || blob.size >= file.size) return file;

    const baseName = (file.name || 'photo').replace(/\.[^/.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', {
        type: 'image/jpeg',
        lastModified: Date.now(),
    });
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
    } catch {
        /* ignore quota / privacy mode errors */
    }
}

export default function EvidenceCapture() {
    const { orderNumber } = useParams();
    const fileInputRef = useRef(null);

    const [summary, setSummary] = useState(null);
    const [summaryError, setSummaryError] = useState('');
    const [loadingSummary, setLoadingSummary] = useState(true);

    const [department, setDepartment] = useState(() => getStoredDept());
    const [showDeptModal, setShowDeptModal] = useState(false);
    const [deptDraft, setDeptDraft] = useState('');

    const [queued, setQueued] = useState([]); // { file, previewUrl }
    const [compressing, setCompressing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null); // { count } | null
    const [uploadError, setUploadError] = useState('');

    // 첫 진입 시 부서가 없으면 모달
    useEffect(() => {
        if (!department) {
            setDeptDraft('');
            setShowDeptModal(true);
        }
    }, [department]);

    // 주문지 요약 조회
    useEffect(() => {
        if (!orderNumber) return;
        let alive = true;
        setLoadingSummary(true);
        fetch(`${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/summary`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.message || '작업지시서를 찾을 수 없습니다.');
                }
                return res.json();
            })
            .then((data) => {
                if (!alive) return;
                setSummary(data);
                setSummaryError('');
            })
            .catch((err) => {
                if (!alive) return;
                setSummary(null);
                setSummaryError(err.message || '작업지시서 조회에 실패했습니다.');
            })
            .finally(() => alive && setLoadingSummary(false));
        return () => {
            alive = false;
        };
    }, [orderNumber]);

    // 미리보기 URL revoke
    useEffect(() => () => {
        queued.forEach((q) => URL.revokeObjectURL(q.previewUrl));
    }, [queued]);

    const totalSize = useMemo(
        () => queued.reduce((sum, q) => sum + (q.file?.size || 0), 0),
        [queued]
    );

    const handlePickFiles = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;

        setCompressing(true);
        setUploadResult(null);
        setUploadError('');

        const processed = [];
        for (const file of files) {
            let finalFile = file;
            try {
                finalFile = await compressImage(file);
            } catch {
                finalFile = file;
            }
            processed.push({
                file: finalFile,
                previewUrl: URL.createObjectURL(finalFile),
            });
        }

        setQueued((prev) => [...prev, ...processed]);
        setCompressing(false);
        // 같은 파일 재선택 가능하게 input value 초기화
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removeQueued = (index) => {
        setQueued((prev) => {
            const next = [...prev];
            const [removed] = next.splice(index, 1);
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
            setUploadResult({ count: body.count || queued.length });
        } catch (err) {
            setUploadError(err.message || '업로드 중 오류가 발생했습니다.');
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

    return (
        <div className="evidence-page">
            <header className="evidence-header">
                <h1 className="evidence-title">작업 사진 업로드</h1>
                <p className="evidence-order">{orderNumber}</p>
                {loadingSummary ? (
                    <p className="evidence-meta">작업지시서 정보를 불러오는 중…</p>
                ) : summary ? (
                    <p className="evidence-meta">
                        {summary.companyName ? `${summary.companyName} · ` : ''}
                        {summary.title || '제목 없음'}
                    </p>
                ) : (
                    <p className="evidence-meta error">{summaryError}</p>
                )}
            </header>

            {summary && (
                <>
                    <div className="evidence-dept-row">
                        <span className="evidence-dept-label">촬영 부서</span>
                        <span className="evidence-dept-value">
                            {department || '미설정'}
                        </span>
                        <button type="button" className="evidence-dept-change" onClick={openChangeDept}>
                            변경
                        </button>
                    </div>

                    <button
                        type="button"
                        className="evidence-camera-btn"
                        onClick={triggerCamera}
                        disabled={uploading || compressing}
                    >
                        <span className="evidence-camera-icon" aria-hidden="true">📷</span>
                        <span>{compressing ? '사진 처리 중…' : '사진 찍기 / 선택하기'}</span>
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
                        <div className="evidence-queue">
                            <div className="evidence-queue-head">
                                <span>{queued.length}장 선택됨</span>
                                <span className="evidence-queue-size">
                                    {(totalSize / (1024 * 1024)).toFixed(1)} MB
                                </span>
                            </div>
                            <div className="evidence-thumbs">
                                {queued.map((q, idx) => (
                                    <div key={`${q.file.name}-${idx}`} className="evidence-thumb">
                                        <img src={q.previewUrl} alt="" />
                                        <button
                                            type="button"
                                            className="evidence-thumb-remove"
                                            onClick={() => removeQueued(idx)}
                                            aria-label="삭제"
                                            disabled={uploading}
                                        >
                                            ×
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <button
                                type="button"
                                className="evidence-upload-btn"
                                onClick={handleUpload}
                                disabled={uploading}
                            >
                                {uploading ? '업로드 중…' : `${queued.length}장 업로드`}
                            </button>
                        </div>
                    )}

                    {uploadError && <div className="evidence-feedback error">{uploadError}</div>}
                    {uploadResult && (
                        <div className="evidence-feedback success">
                            ✓ {uploadResult.count}장 업로드 완료. 추가로 더 찍을 수 있습니다.
                        </div>
                    )}
                </>
            )}

            {showDeptModal && (
                <div className="evidence-modal-backdrop" onClick={() => department && setShowDeptModal(false)}>
                    <div className="evidence-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>촬영 부서 입력</h2>
                        <p className="evidence-modal-desc">
                            이 휴대폰에서 올린 사진이 어느 부서에서 올린 건지 표시됩니다. 한 번만 입력하면 다음부터는 자동으로 사용됩니다.
                        </p>
                        <div className="evidence-quick-chips">
                            {QUICK_DEPTS.map((dept) => (
                                <button
                                    key={dept}
                                    type="button"
                                    className={`evidence-chip ${deptDraft === dept ? 'active' : ''}`}
                                    onClick={() => setDeptDraft(dept)}
                                >
                                    {dept}
                                </button>
                            ))}
                        </div>
                        <input
                            type="text"
                            className="evidence-dept-input"
                            placeholder="직접 입력 (예: 외주관리)"
                            value={deptDraft}
                            maxLength={MAX_DEPT_LEN}
                            onChange={(e) => setDeptDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submitDept();
                            }}
                            autoFocus
                        />
                        <div className="evidence-modal-actions">
                            {department && (
                                <button
                                    type="button"
                                    className="evidence-modal-cancel"
                                    onClick={() => setShowDeptModal(false)}
                                >
                                    취소
                                </button>
                            )}
                            <button
                                type="button"
                                className="evidence-modal-confirm"
                                onClick={submitDept}
                                disabled={!deptDraft.trim()}
                            >
                                저장
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
