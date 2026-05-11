import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import './EvidenceCapture.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const DEPT_KEY = 'hdsign_uploader_department';
const QUICK_DEPTS = ['완조립부', 'CNC가공부', 'LED조립부', '에폭시부', '아크릴가공부(5층)', '배송팀', '도장부', '후레임부'];
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
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const fileInputRef = useRef(null);
    const flashTimerRef = useRef(null);
    const successTimerRef = useRef(null);

    const [summary, setSummary] = useState(null);
    const [summaryError, setSummaryError] = useState('');
    const [loadingSummary, setLoadingSummary] = useState(true);

    const [department, setDepartment] = useState(() => getStoredDept());
    const [showDeptModal, setShowDeptModal] = useState(false);
    const [deptDraft, setDeptDraft] = useState('');

    // 인앱 카메라 상태
    const [cameraReady, setCameraReady] = useState(false);
    const [cameraError, setCameraError] = useState('');
    const [needsTapToStart, setNeedsTapToStart] = useState(false);

    // 셔터 → 즉시 업로드(백그라운드). 동시에 여러 장 찍어도 큐 없이 병렬 진행.
    const [inFlight, setInFlight] = useState(0);
    const [uploadedCount, setUploadedCount] = useState(0);
    const [recentPreview, setRecentPreview] = useState(null); // blob URL of last shot
    const [flashOn, setFlashOn] = useState(false); // 셔터 누른 순간 화면 흰 깜빡임
    const [showSuccess, setShowSuccess] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');

    // 첫 진입 시 부서 없으면 모달
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

    // 카메라 시작 — getUserMedia 로 실시간 스트림. 별도 OS 카메라 앱 안 띄움.
    const startCamera = useCallback(async () => {
        if (streamRef.current) return;
        setCameraError('');
        setNeedsTapToStart(false);
        if (!navigator.mediaDevices?.getUserMedia) {
            setCameraError('이 브라우저에서는 카메라를 직접 켤 수 없습니다. 갤러리에서 선택해주세요.');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            });
            streamRef.current = stream;
            const video = videoRef.current;
            if (video) {
                video.srcObject = stream;
                try {
                    await video.play();
                } catch {
                    // iOS Safari: 사용자 제스처 없이 재생 차단된 경우 — 탭으로 시작 안내
                    setNeedsTapToStart(true);
                    return;
                }
            }
            setCameraReady(true);
        } catch (err) {
            const name = err?.name || '';
            if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                setCameraError('카메라 권한이 차단되어 있습니다. 권한 허용 후 새로고침하거나 갤러리에서 선택해주세요.');
            } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                setCameraError('사용 가능한 카메라를 찾지 못했습니다. 갤러리에서 선택해주세요.');
            } else {
                setCameraError('카메라를 시작할 수 없습니다. 갤러리에서 선택해주세요.');
            }
        }
    }, []);

    const stopCamera = useCallback(() => {
        const stream = streamRef.current;
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        }
        const video = videoRef.current;
        if (video) {
            try { video.pause(); } catch {}
            video.srcObject = null;
        }
        setCameraReady(false);
    }, []);

    // 부서 + 요약 모두 준비되면 카메라 자동 시작. 모달 떠있으면 보류.
    useEffect(() => {
        if (!department || !summary || showDeptModal) return;
        startCamera();
        return () => stopCamera();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [department, summary, showDeptModal]);

    // 페이지 가려지면 카메라 중지(배터리 절약), 다시 보이면 재시작
    useEffect(() => {
        const onVis = () => {
            if (document.hidden) {
                stopCamera();
            } else if (department && summary && !showDeptModal) {
                startCamera();
            }
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, [department, summary, showDeptModal, startCamera, stopCamera]);

    // 미리보기 URL revoke
    useEffect(() => {
        return () => {
            if (recentPreview) URL.revokeObjectURL(recentPreview);
        };
    }, [recentPreview]);

    useEffect(() => {
        return () => {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            if (successTimerRef.current) clearTimeout(successTimerRef.current);
        };
    }, []);

    const showSuccessFlash = () => {
        setShowSuccess(true);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setShowSuccess(false), 1500);
    };

    const triggerFlash = () => {
        setFlashOn(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashOn(false), 140);
    };

    // 백그라운드 업로드 — 셔터 응답성 우선. 결과는 카운터/플래시로 알림.
    const uploadFile = async (file) => {
        setInFlight((n) => n + 1);
        setErrorMsg('');
        try {
            const fd = new FormData();
            fd.append('department', department);
            fd.append('files', file, file.name);
            const res = await fetch(
                `${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/evidence`,
                { method: 'POST', body: fd }
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || '업로드에 실패했습니다.');
            }
            const body = await res.json().catch(() => ({}));
            const added = body?.count || 1;
            setUploadedCount((c) => c + added);
            showSuccessFlash();
        } catch (err) {
            setErrorMsg(err.message || '업로드 중 오류가 발생했습니다.');
        } finally {
            setInFlight((n) => Math.max(0, n - 1));
        }
    };

    // 셔터 — video → canvas → blob → 즉시 업로드. UI는 즉시 다음 촬영 가능.
    const handleShutter = async () => {
        if (!cameraReady) return;
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        if (!department) {
            setDeptDraft('');
            setShowDeptModal(true);
            return;
        }

        triggerFlash();

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const longest = Math.max(vw, vh);
        const scale = longest > COMPRESS_MAX_DIM ? COMPRESS_MAX_DIM / longest : 1;
        const cw = Math.max(1, Math.round(vw * scale));
        const ch = Math.max(1, Math.round(vh * scale));

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, cw, ch);

        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY)
        );
        if (!blob) return;

        // 직전 촬영 미리보기 갱신 (이전 URL 정리)
        const previewUrl = URL.createObjectURL(blob);
        setRecentPreview((old) => {
            if (old) URL.revokeObjectURL(old);
            return previewUrl;
        });

        const file = new File([blob], `evidence_${Date.now()}.jpg`, {
            type: 'image/jpeg',
            lastModified: Date.now(),
        });
        // 백그라운드 업로드 — await 안 함
        uploadFile(file);
    };

    // 갤러리 선택 폴백 (카메라 권한 없을 때 또는 기존 사진 보낼 때)
    const handlePickFiles = async (e) => {
        const files = Array.from(e.target.files || []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (!files.length) return;
        if (!department) {
            setDeptDraft('');
            setShowDeptModal(true);
            return;
        }
        setErrorMsg('');
        for (const raw of files) {
            let f = raw;
            try {
                f = await compressImage(raw);
            } catch {
                f = raw;
            }
            // 마지막 한 장만 미리보기로 노출
            try {
                const url = URL.createObjectURL(f);
                setRecentPreview((old) => {
                    if (old) URL.revokeObjectURL(old);
                    return url;
                });
            } catch {}
            uploadFile(f);
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

    const cameraBlocked = Boolean(cameraError);

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

                    <div className={`evidence-stage ${cameraBlocked ? 'is-blocked' : ''}`}>
                        <video
                            ref={videoRef}
                            className="evidence-video"
                            playsInline
                            muted
                            autoPlay
                        />

                        {flashOn && <div className="evidence-flash" aria-hidden="true" />}

                        {!cameraBlocked && !cameraReady && !needsTapToStart && (
                            <div className="evidence-stage-overlay">
                                <span>카메라 준비 중…</span>
                            </div>
                        )}

                        {needsTapToStart && (
                            <button
                                type="button"
                                className="evidence-stage-overlay tap"
                                onClick={() => startCamera()}
                            >
                                <span className="evidence-tap-icon" aria-hidden="true">📷</span>
                                <span>탭하여 카메라 시작</span>
                            </button>
                        )}

                        {cameraBlocked && (
                            <div className="evidence-stage-overlay error">
                                <p>{cameraError}</p>
                                <button
                                    type="button"
                                    className="evidence-fallback-btn"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    🖼️ 갤러리에서 선택
                                </button>
                            </div>
                        )}

                        {/* 큰 셔터 영역 — 카메라 미리보기 위 어디든 탭 가능 */}
                        {!cameraBlocked && cameraReady && (
                            <button
                                type="button"
                                className="evidence-shutter-tap"
                                onClick={handleShutter}
                                aria-label="촬영"
                            />
                        )}

                        {/* 우상단 누적 카운터 + 진행 표시 */}
                        <div className="evidence-counter">
                            {inFlight > 0 && <span className="evidence-counter-spinner" aria-hidden="true" />}
                            <span className="evidence-counter-num">
                                {uploadedCount > 0 ? `✓ ${uploadedCount}` : ''}
                            </span>
                        </div>

                        {/* 좌하단 직전 촬영 미리보기 */}
                        {recentPreview && (
                            <div className="evidence-recent" aria-hidden="true">
                                <img src={recentPreview} alt="" />
                            </div>
                        )}

                        {/* 성공 플래시 */}
                        {showSuccess && (
                            <div className="evidence-success-flash" aria-hidden="true">
                                <span>✓</span>
                            </div>
                        )}
                    </div>

                    {/* 셔터 바 — 큰 원형 버튼 + 갤러리 보조 버튼 */}
                    {!cameraBlocked && (
                        <div className="evidence-bar">
                            <button
                                type="button"
                                className="evidence-bar-side"
                                onClick={() => fileInputRef.current?.click()}
                                aria-label="갤러리에서 선택"
                                title="갤러리에서 선택"
                            >
                                🖼️
                            </button>
                            <button
                                type="button"
                                className={`evidence-shutter ${cameraReady ? '' : 'is-disabled'}`}
                                onClick={handleShutter}
                                disabled={!cameraReady}
                                aria-label="촬영"
                            >
                                <span className="evidence-shutter-ring" aria-hidden="true" />
                                <span className="evidence-shutter-core" aria-hidden="true" />
                            </button>
                            <div className="evidence-bar-side evidence-bar-status" aria-live="polite">
                                {uploadedCount > 0 ? (
                                    <span className="evidence-bar-num">{uploadedCount}장</span>
                                ) : (
                                    <span className="evidence-bar-hint">셔터 탭</span>
                                )}
                            </div>
                        </div>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        onChange={handlePickFiles}
                        style={{ display: 'none' }}
                    />

                    {errorMsg && <div className="evidence-feedback error">{errorMsg}</div>}
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
