import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ALL_WORKERS } from '../../data/workers.js';
import './EvidenceQuickCapture.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
// 모바일 뷰어와 동일한 키 공유 — 이미 모바일에서 본인 이름 골라놓은 폰은 자동.
const WORKER_KEY = 'hdsign_uploader_worker';
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;

function getStoredWorker() {
    try { return (localStorage.getItem(WORKER_KEY) || '').trim(); }
    catch { return ''; }
}
function setStoredWorker(v) {
    try {
        if (v) localStorage.setItem(WORKER_KEY, v);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
}

async function compressImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { return file; }

    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const scale = longest > COMPRESS_MAX_DIM ? COMPRESS_MAX_DIM / longest : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', COMPRESS_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const baseName = (file.name || 'photo').replace(/\.[^/.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}

export default function EvidenceQuickCapture() {
    const { orderNumber } = useParams();
    const fileInputRef = useRef(null);
    const recentUrlRef = useRef(null);

    const [worker, setWorker] = useState(() => getStoredWorker());
    const [showWorkerPicker, setShowWorkerPicker] = useState(false);

    const [summary, setSummary] = useState(null);
    const [summaryError, setSummaryError] = useState('');
    const [summaryLoading, setSummaryLoading] = useState(true);

    const [uploading, setUploading] = useState(false);
    const [result, setResult] = useState(null); // { ok: bool, message: string, thumbUrl?: string }

    // 주문 요약 prefetch — 페이지 로드와 동시
    useEffect(() => {
        if (!orderNumber) return;
        let alive = true;
        setSummaryLoading(true);
        fetch(`${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/summary`)
            .then(async (res) => {
                if (!res.ok) {
                    const b = await res.json().catch(() => ({}));
                    throw new Error(b.message || '작업지시서를 찾을 수 없습니다.');
                }
                return res.json();
            })
            .then((d) => { if (alive) { setSummary(d); setSummaryError(''); }})
            .catch((e) => { if (alive) setSummaryError(e.message || '작업지시서를 불러오지 못했습니다.'); })
            .finally(() => { if (alive) setSummaryLoading(false); });
        return () => { alive = false; };
    }, [orderNumber]);

    // 작업자 미설정 시 모달 자동 노출
    useEffect(() => {
        if (!worker) setShowWorkerPicker(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 미리보기 blob URL revoke
    useEffect(() => () => {
        if (recentUrlRef.current) {
            URL.revokeObjectURL(recentUrlRef.current);
            recentUrlRef.current = null;
        }
    }, []);

    const openCamera = () => {
        if (!worker) { setShowWorkerPicker(true); return; }
        if (summaryError) return;
        fileInputRef.current?.click();
    };

    const handleFile = async (e) => {
        const files = Array.from(e.target.files || []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (!files.length) return;

        setUploading(true);
        setResult(null);
        try {
            const file = await compressImage(files[0]);

            // 새 미리보기 URL 생성 + 이전 거 revoke
            const newUrl = URL.createObjectURL(file);
            if (recentUrlRef.current) URL.revokeObjectURL(recentUrlRef.current);
            recentUrlRef.current = newUrl;

            const fd = new FormData();
            fd.append('department', worker);
            fd.append('files', file, file.name || 'photo.jpg');

            const res = await fetch(
                `${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/evidence`,
                { method: 'POST', body: fd },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                throw new Error(b.message || '업로드에 실패했습니다.');
            }
            await res.json().catch(() => ({}));
            const company = summary?.companyName || '거래처';
            setResult({ ok: true, message: `${company} 사진 업로드가 완료되었습니다.`, thumbUrl: newUrl });
        } catch (err) {
            setResult({ ok: false, message: err.message || '업로드 중 오류가 발생했습니다.' });
        } finally {
            setUploading(false);
        }
    };

    const submitWorker = (name) => {
        setWorker(name);
        setStoredWorker(name);
        setShowWorkerPicker(false);
    };

    return (
        <div className="qc-page">
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFile}
                style={{ display: 'none' }}
            />

            <div className="qc-card">
                {summaryError ? (
                    <div className="qc-error-big">
                        <div className="qc-error-icon">!</div>
                        <div>{summaryError}</div>
                    </div>
                ) : (
                    <>
                        <h1 className="qc-company">
                            {summaryLoading ? '...' : (summary?.companyName || '거래처미상')}
                        </h1>
                        {summary?.title && <p className="qc-title">{summary.title}</p>}
                        <p className="qc-order-no">{orderNumber}</p>

                        <div className="qc-worker-row">
                            <span>담당자</span>
                            <strong>{worker || '미설정'}</strong>
                            <button type="button" onClick={() => setShowWorkerPicker(true)}>변경</button>
                        </div>

                        {!result && (
                            <button
                                type="button"
                                className="qc-capture-btn"
                                onClick={openCamera}
                                disabled={uploading || summaryLoading}
                            >
                                {uploading ? '업로드 중…' : '📷 사진 촬영'}
                            </button>
                        )}

                        {result?.ok && (
                            <div className="qc-result qc-result-ok">
                                <div className="qc-result-icon">✓</div>
                                <div className="qc-result-msg">{result.message}</div>
                                {result.thumbUrl && (
                                    <img src={result.thumbUrl} alt="" className="qc-thumb" />
                                )}
                                <button type="button" className="qc-again-btn" onClick={openCamera}>
                                    📷 한 장 더 촬영
                                </button>
                            </div>
                        )}

                        {result && !result.ok && (
                            <div className="qc-result qc-result-fail">
                                <div className="qc-result-icon">✗</div>
                                <div className="qc-result-msg">{result.message}</div>
                                <button type="button" className="qc-again-btn" onClick={openCamera}>
                                    다시 시도
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            {showWorkerPicker && (
                <div
                    className="qc-picker-backdrop"
                    onClick={() => worker && setShowWorkerPicker(false)}
                >
                    <div className="qc-picker" onClick={(e) => e.stopPropagation()}>
                        <h2>담당자 선택</h2>
                        <p className="qc-picker-desc">
                            이 휴대폰에서 올린 사진이 누가 올린 건지 표시됩니다.<br/>
                            한 번만 선택하면 다음 사진부터는 자동으로 적용됩니다.
                        </p>
                        <div className="qc-picker-chips">
                            {ALL_WORKERS.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={`qc-picker-chip${worker === name ? ' active' : ''}`}
                                    onClick={() => submitWorker(name)}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
