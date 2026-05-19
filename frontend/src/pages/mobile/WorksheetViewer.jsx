import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetViewer.css';
import { ALL_WORKERS } from '../../data/workers.js';
import CompletionConfirmModal from '../../components/common/CompletionConfirmModal.jsx';
import {
    peekDetail,
    rememberDetail,
    prefetchSiblingByOrderNumber,
} from './pdfPrefetch.js';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
// 모바일 직원 식별 — WorksheetList 와 같은 키 공유. 휴대폰 단말 단위로 본인 이름을 한 번 설정.
const WORKER_KEY = 'hdsign_uploader_worker';
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;
const DEFAULT_PAGE_RATIO = 1 / Math.sqrt(2);
// PDF 렌더 DPR — 두 단계로 그린다. 첫 paint 는 FAST(낮은 DPR)로 빠르게 띄우고,
// onRenderSuccess 직후 requestIdleCallback 으로 DETAIL(높은 DPR)로 재렌더해 선명도를 올린다.
// 사용자가 핀치로 줌하면 onZoomStop 에서 도달한 줌 단계에 맞춰 추가 승급(qualityScale).
//
// 가독성 우선 튜닝(작은 글씨도 또렷, 핀치 중에도 벡터처럼):
//   - DETAIL_DPR 12 — idle 승급 후 캔버스가 deviceDpr 3 기준 4x 오버샘플 보유.
//     핀치 1~4x 구간은 캔버스 픽셀이 화면 device-pixel 보다 많아서 CSS 트랜스폼 보간이
//     생기지 않음 → 핀치 중에도 글자가 흐려지지 않고 종이처럼 또렷. 4x 초과는 onZoomStop
//     에서 qualityScale 재렌더로 보강.
//   - OVERSAMPLE 1.25 — deviceDpr×줌 위로 25% 더 샘플링해서 핀치 5~7x 구간 재렌더가 sharp.
//   - MAX_DPR 20 / MAX_CANVAS_PIXELS 80M / JS_MAX_IMAGE_BYTES 384MB — 핀치 5~7x 캔버스
//     상한. 5x 까지 완전 1:1 + 25% 오버샘플, 7x 에선 ~95% 해상도(살짝만 흐림) — 사용자가
//     허용한 "최대 확대 시 약간 흐린 정도".
//   - FAST_DPR 2.4 — 첫 paint(=loading 체감 시간) 는 그대로 유지. idle 승급은 첫 paint
//     이후라 로딩 속도에는 영향 없음.
//
// 비용: idle 승급 캔버스가 ~26M 픽셀(105MB) — 모던폰 충분. 캔버스 할당 실패 시
// PDF_RENDER_FALLBACK_FACTORS 가 단계적으로 DPR 을 낮춰 재시도해서 구형 iPhone(8 이하) 도
// 자연스럽게 fallback 으로 안착.
const PDF_FAST_DPR = 2.4;
const PDF_DETAIL_DPR = 12;
const PDF_MAX_DPR = 20;
const PDF_OVERSAMPLE = 1.25;
const PDF_MAX_CANVAS_PIXELS = 80_000_000;
const PDF_JS_MAX_IMAGE_BYTES = 384 * 1024 * 1024;
const PINCH_MAX_SCALE = 7;
const PDF_ZOOM_RENDER_STEPS = [1, 2, 3, 5, 7];
// 최고 DPR 에서 캔버스 할당 실패/pdf.js 내부 에러가 나면 DPR 을 단계적으로 낮추며
// 재시도. 빈 화면으로 멈추는 대신 약간 낮은 화질로라도 보이게 하는 안전망.
// 35% 까지 내려가도 deviceDpr 3 환경에선 여전히 6 DPR 안팎이라 옛 설정(MAX=14)과
// 비슷한 화질이 유지된다. 마지막 단계까지 가도 안 되면 거기서 멈춤(무한루프 방지).
const PDF_RENDER_FALLBACK_FACTORS = [1, 0.7, 0.5, 0.35];

function getPdfQualityScale(scale) {
    const value = Number.isFinite(scale) ? Math.max(1, Math.min(PINCH_MAX_SCALE, scale)) : 1;
    return PDF_ZOOM_RENDER_STEPS.find((step) => value <= step) || PINCH_MAX_SCALE;
}

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

function getStoredWorker() {
    try {
        const v = localStorage.getItem(WORKER_KEY);
        return v ? v.trim() : '';
    } catch {
        return '';
    }
}
function setStoredWorker(value) {
    try {
        if (value) localStorage.setItem(WORKER_KEY, value);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
}

const DELIVERY_LABELS = {
    CARGO: '화물', QUICK: '퀵', DIRECT: '직접배송', PICKUP: '직접수령', LOCAL_CARGO: '용달',
};

export default function WorksheetViewer() {
    const { orderNumber } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const cameraInputRef = useRef(null);
    const galleryInputRef = useRef(null);
    const stageRef = useRef(null);
    // 스와이프 좌/우 → 같은 필터링/정렬 순서의 다음·이전 지시서로 이동.
    // List 페이지에서 navigate state 로 전달된 orderNumber 배열을 그대로 사용.
    // 직접 URL 진입(state 없음) 시 빈 배열 → 스와이프 무시.
    const siblings = useMemo(() => {
        const list = location.state?.siblings;
        return Array.isArray(list) ? list : [];
    }, [location.state]);
    const currentIdx = useMemo(
        () => (siblings.length ? siblings.indexOf(orderNumber) : -1),
        [siblings, orderNumber],
    );
    const prevSibling = currentIdx > 0 ? siblings[currentIdx - 1] : null;
    const nextSibling = currentIdx >= 0 && currentIdx < siblings.length - 1
        ? siblings[currentIdx + 1]
        : null;
    const navigateSibling = useCallback((target) => {
        if (!target) return;
        navigate(`/m/worksheets/${encodeURIComponent(target)}`, {
            state: { siblings },
            replace: true, // 히스토리 폭주 방지 — 뒤로가기는 항상 목록으로.
        });
    }, [navigate, siblings]);
    // 터치 시작점 — 스와이프 판별용. 스케일 1 상태에서만 좌우 스와이프를 네비로 가로챈다.
    // 줌 상태(scale > 1)에서는 사용자가 PDF 를 패닝 중이라 가로채면 안 됨.
    const swipeStartRef = useRef(null);
    const swipeNavigatedRef = useRef(false);
    // TransformWrapper 의 onTransformed 콜백으로 매 transform 변화 시점에 갱신 — touchstart 에서
    // ref.instance.transformState 를 직접 읽으면 라이브러리 버전에 따라 path 가 안 잡혀
    // 1 로 떨어지던 문제(확대 후 한 손가락 패닝 → 스와이프 네비로 오인) 방지.
    const currentScaleRef = useRef(1);

    // 진입 즉시 캐시된 detail(목록 페이지가 채웠거나 직전에 본 지시서) 을 사용해
    // 회사명/제목/납기 와 PDF URL 을 즉시 표시. fetchDetail 은 백그라운드에서 새로
    // 가져와 갱신(stale-while-revalidate). 진입 시 첫 렌더부터 빈 화면이 사라진다.
    const [detail, setDetail] = useState(() => peekDetail(orderNumber));
    const [detailError, setDetailError] = useState('');
    const [loadingDetail, setLoadingDetail] = useState(() => !peekDetail(orderNumber));
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageRatio, setPageRatio] = useState(DEFAULT_PAGE_RATIO);
    const [pdfReady, setPdfReady] = useState(false);
    const [pdfError, setPdfError] = useState('');
    const [renderAttempt, setRenderAttempt] = useState(0);
    // 가로형 PDF(/Rotate=90/270 또는 MediaBox 자체가 가로) 는 90° 추가 회전해
    // 화면을 portrait 으로 채워 글자를 크게 보여준다. 사용자는 폰을 좌측으로
    // 돌려서 읽으면 자연스럽게 landscape 로 보임. 0 = 회전 없음(=PDF 자체 /Rotate 사용).
    const [pageRotation, setPageRotation] = useState(0);

    // 시트 (사진 큐가 있을 때 자동으로 열림 — 사용자가 직접 토글하진 않음)
    const [sheetOpen, setSheetOpen] = useState(false);
    // PDF 한 번 탭 → 상단/하단 chrome 보임/숨김 토글. 더블탭(줌 토글)과 충돌 막으려고 280ms 디바운스.
    // 처음 진입 시엔 보이게 시작 — 작업자가 액션 버튼을 인지할 수 있도록.
    const [chromeVisible, setChromeVisible] = useState(true);
    const stageTapTimerRef = useRef(null);
    const [worker, setWorker] = useState(() => getStoredWorker());
    const [showWorkerModal, setShowWorkerModal] = useState(false);
    const [workerDraft, setWorkerDraft] = useState('');
    const [queued, setQueued] = useState([]);
    const [compressing, setCompressing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [uploadError, setUploadError] = useState('');
    // 작업완료 신고 — 본인이 누르면 백엔드에 workerCompletedBy/At 기록되고, 모바일 리스트에서
    // 본인뿐 아니라 같은 슬롯 동료에게서도 사라진다(claim 모델). 멱등 — 이미 완료된 건이면 200.
    const [completing, setCompleting] = useState(false);
    const [completeError, setCompleteError] = useState('');
    // 작업완료 확인 모달 — window.confirm 대신 사용. null 이면 닫힘.
    // value: 'upload' (사진 업로드 직후 자동 노출) 또는 'manual' ([작업완료] 버튼 직접 클릭).
    const [completeConfirmKind, setCompleteConfirmKind] = useState(null);
    // PDF 전환 깜빡임 완화 — 캐시 히트로 빠르게 로드되는 경우(<300ms) "PDF 불러오는 중…"
    // 텍스트가 한 프레임 깜빡 떴다 사라지는 시각적 잡음을 없앤다. 진짜 느린 경우만 텍스트 노출.
    const [showSlowLoading, setShowSlowLoading] = useState(false);
    const [pdfViewKey, setPdfViewKey] = useState(0);
    const [highQualityRender, setHighQualityRender] = useState(false);
    const [qualityScale, setQualityScale] = useState(1);
    const transformRef = useRef(null);

    // 업로드된 증거사진 목록 — [사진보기] 시트 + 라이트박스 + 카톡 공유에 사용.
    // orderNumber 진입 시 1회 + 업로드 직후/시트 오픈 시 재조회. 인증 없는 공개 API.
    const [evidencePhotos, setEvidencePhotos] = useState([]);
    const [photosSheetOpen, setPhotosSheetOpen] = useState(false);
    const [lightboxIndex, setLightboxIndex] = useState(null);
    const [sharing, setSharing] = useState(false);
    const [shareToast, setShareToast] = useState('');
    // 지시서 자체(현재 페이지) 카톡 공유 — 캔버스를 JPEG 로 만들어 navigator.share files API 로.
    const [sharingWorksheet, setSharingWorksheet] = useState(false);
    const [worksheetShareToast, setWorksheetShareToast] = useState('');

    const requestPdfQualityForScale = useCallback((scale) => {
        const nextScale = getPdfQualityScale(scale);
        setHighQualityRender(true);
        setQualityScale((prev) => (prev === nextScale ? prev : nextScale));
    }, []);

    // 증거사진 목록 새로고침 — 진입/업로드 후/시트 열기 직전에 호출.
    const refreshEvidencePhotos = useCallback(async () => {
        if (!orderNumber) return;
        try {
            const res = await fetch(
                `${BASE_URL}/api/public/orders/${encodeURIComponent(orderNumber)}/evidence?_=${Date.now()}`,
                { cache: 'no-store' }
            );
            if (!res.ok) return;
            const data = await res.json();
            setEvidencePhotos(Array.isArray(data?.items) ? data.items : []);
        } catch {
            /* 목록은 실패해도 흐름 차단 안 함 */
        }
    }, [orderNumber]);

    useEffect(() => {
        setEvidencePhotos([]);
        refreshEvidencePhotos();
    }, [refreshEvidencePhotos]);

    const openPhotosSheet = useCallback(() => {
        refreshEvidencePhotos();
        setPhotosSheetOpen(true);
    }, [refreshEvidencePhotos]);

    const closePhotosSheet = useCallback(() => {
        setPhotosSheetOpen(false);
    }, []);

    const closeLightbox = useCallback(() => setLightboxIndex(null), []);

    // 라이트박스에서 사진을 카톡/공유 — Web Share API 우선, files 미지원이면 URL 만 공유.
    // title/text 는 일부러 넘기지 않는다 — 안드로이드 카톡 공유에서 그 텍스트가 별도 채팅 메시지로
    // 같이 전송되어 사용자가 "사진만 보내고 싶다" 는 의도를 침해하기 때문(사진만 깔끔하게 전송).
    // 둘 다 안 되면 새 탭에 띄워 사용자가 길게 눌러 저장하도록 안내.
    const shareCurrentPhoto = useCallback(async () => {
        if (lightboxIndex === null) return;
        const photo = evidencePhotos[lightboxIndex];
        if (!photo) return;
        const url = `${BASE_URL}${photo.imageUrl}`;
        setSharing(true);
        setShareToast('');
        try {
            // 1) files 지원 — 카톡 공유에서 실제 사진이 첨부됨.
            try {
                const res = await fetch(url, { cache: 'no-store' });
                if (res.ok) {
                    const blob = await res.blob();
                    const fileName = photo.originalName || 'photo.jpg';
                    const file = new File([blob], fileName, {
                        type: blob.type || photo.contentType || 'image/jpeg',
                    });
                    if (typeof navigator !== 'undefined'
                        && navigator.canShare
                        && navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file] });
                        return;
                    }
                }
            } catch (err) {
                if (err?.name === 'AbortError') return;
            }
            // 2) URL 만 공유 — 카톡엔 링크가 가고, 받은 사람이 클릭해서 본다.
            if (typeof navigator !== 'undefined' && navigator.share) {
                try {
                    await navigator.share({ url });
                    return;
                } catch (err) {
                    if (err?.name === 'AbortError') return;
                }
            }
            // 3) 최후 폴백 — 새 탭에 띄워 길게 눌러 저장 후 직접 카톡 전송.
            window.open(url, '_blank', 'noopener');
            setShareToast('새 창에서 사진을 길게 눌러 저장한 뒤 카톡으로 보내주세요.');
        } finally {
            setSharing(false);
        }
    }, [evidencePhotos, lightboxIndex]);

    // 지시서 공유 — 현재 화면에 그려진 PDF 페이지 캔버스를 JPEG 로 변환해 카톡 공유.
    // PDF 자체를 공유하면 카톡 미리보기가 깨지거나 다운로드를 강제하는 단말이 많아 이미지 방식이 가장 호환성 좋다.
    // 캔버스가 아직 그려지지 않은 상태(초기 로딩/에러) 면 토스트로 안내.
    const shareWorksheet = useCallback(async () => {
        if (sharingWorksheet) return;
        const canvas = stageRef.current?.querySelector('.wsv-page-canvas canvas');
        if (!canvas || !pdfReady) {
            setWorksheetShareToast('지시서가 다 열린 다음에 공유해 주세요.');
            return;
        }
        setSharingWorksheet(true);
        setWorksheetShareToast('');
        try {
            const blob = await new Promise((resolve) => {
                try {
                    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
                } catch {
                    resolve(null);
                }
            });
            if (!blob) {
                setWorksheetShareToast('지시서 이미지를 만들지 못했어요.');
                return;
            }
            const safeBase = (detail?.title || orderNumber || 'worksheet')
                .replace(/[\\/:*?"<>|]/g, '_')
                .slice(0, 80);
            const suffix = numPages > 1 ? `_p${currentPage}` : '';
            const fileName = `${safeBase}${suffix}.jpg`;
            const file = new File([blob], fileName, { type: 'image/jpeg' });
            // title/text 는 의도적으로 전달하지 않음 — 안드로이드 카톡 공유에서 그 텍스트가
            // 별도 채팅 메시지로 같이 전송되어 사용자 의도("사진만 보내기") 를 침해함.
            if (typeof navigator !== 'undefined'
                && navigator.canShare
                && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file] });
                    return;
                } catch (err) {
                    if (err?.name === 'AbortError') return;
                    // files 공유 실패 → 폴백 단계로 이어감
                }
            }
            // 폴백 — 이미지 파일을 다운로드해 사용자가 카톡 [+]→[사진] 으로 첨부.
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            setWorksheetShareToast('지시서를 사진으로 저장했어요. 카톡 [+] → [사진] 으로 전송하세요.');
        } catch (err) {
            if (err?.name !== 'AbortError') {
                setWorksheetShareToast('공유 중 오류가 발생했어요.');
            }
        } finally {
            setSharingWorksheet(false);
        }
    }, [currentPage, detail?.title, numPages, orderNumber, pdfReady, sharingWorksheet]);

    useEffect(() => () => {
        if (stageTapTimerRef.current) clearTimeout(stageTapTimerRef.current);
    }, []);

    // PDF 영역 한 번 탭 → 상단/하단 chrome(주문번호바, 액션바) 토글.
    // react-zoom-pan-pinch 가 패닝/핀치 중에는 click 합성을 막아주므로 여기엔 단순 탭만 들어온다.
    // 더블탭(줌 토글) 과 충돌하지 않도록 280ms 디바운스: 두 번째 탭이 빠르게 오면 단발 탭 액션은
    // 취소(=라이브러리가 doubleClick 줌으로 처리하도록 양보).
    // 스와이프로 인해 발생한 합성 click 은 swipeNavigatedRef 로 차단.
    const handleStageTap = useCallback((e) => {
        if (swipeNavigatedRef.current) {
            swipeNavigatedRef.current = false;
            return;
        }
        if (e?.target instanceof Element) {
            const t = e.target;
            if (t.closest('.wsv-pager')) return;
        }
        if (stageTapTimerRef.current) {
            clearTimeout(stageTapTimerRef.current);
            stageTapTimerRef.current = null;
            return;
        }
        stageTapTimerRef.current = setTimeout(() => {
            stageTapTimerRef.current = null;
            setChromeVisible((v) => !v);
        }, 280);
    }, []);

    // v4 ref 의 state 는 라이브러리가 매 프레임 동기로 갱신 — 직접 읽어 항상 최신 값.
    // currentScaleRef 는 onTransform 콜백 보조용 (둘 중 큰 값으로 보수적 판정).
    const getCurrentScale = useCallback(() => {
        const fromRef = transformRef.current?.state?.scale;
        const fromCb = currentScaleRef.current;
        return Math.max(typeof fromRef === 'number' ? fromRef : 1, fromCb || 1);
    }, []);

    // 한 손가락 좌/우 스와이프 → 다음·이전 지시서. 두 손가락 핀치/패닝과 분리.
    // 스케일 > 1.01(사용자가 줌인한 상태) 면 라이브러리가 패닝을 처리해야 하므로 가로채지 않음.
    const handleStageTouchStart = useCallback((e) => {
        if (e.touches.length !== 1) {
            swipeStartRef.current = null;
            return;
        }
        if (getCurrentScale() > 1.01) {
            swipeStartRef.current = null;
            return;
        }
        const t = e.touches[0];
        swipeStartRef.current = {
            x: t.clientX,
            y: t.clientY,
            time: Date.now(),
        };
    }, [getCurrentScale]);

    const handleStageTouchEnd = useCallback((e) => {
        const start = swipeStartRef.current;
        swipeStartRef.current = null;
        if (!start || !e.changedTouches?.[0]) return;
        // 터치 도중 라이브러리가 줌을 변경했을 가능성 — touchend 시점에서 한 번 더 확인.
        if (getCurrentScale() > 1.01) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        const dt = Date.now() - start.time;
        if (Math.abs(dx) < 60 || Math.abs(dy) > 60 || dt > 600) return;
        // 좌→우(dx > 0) = 이전, 우→좌(dx < 0) = 다음. 자연스러운 책 페이지 넘기기 방향.
        const target = dx < 0 ? nextSibling : prevSibling;
        if (!target) return;
        swipeNavigatedRef.current = true;
        // 스와이프 직후 detail JSON 만 미리 받아둔다 — 새 viewer mount 시점에 detail.worksheetPdfUrl
        // 이 즉시 채워져서 PDF.js 의 첫 range 요청이 네트워크 왕복 1회 빨라진다.
        prefetchSiblingByOrderNumber(BASE_URL, target);
        navigateSibling(target);
    }, [getCurrentScale, nextSibling, prevSibling, navigateSibling]);

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
    // ★ 진입 시: peekDetail() 로 채워둔 캐시가 있으면 initialState 가 이미 채워졌으므로
    //   fetch 는 백그라운드 갱신만 수행 — loading UI 는 안 보이고 사용자는 즉시 화면을 본다.
    useEffect(() => {
        if (!orderNumber) return;
        let alive = true;
        const aliveCheck = () => alive;
        // initial 의미 — 첫 화면이 비어있을 때만 loading/error 를 UI 에 표시(true).
        // 캐시로 이미 채워져 있으면 false → 조용히 백그라운드 갱신.
        const cachedDetail = peekDetail(orderNumber);
        const hadCachedDetail = !!cachedDetail;
        const canOpenFromCache = !!cachedDetail?.worksheetPdfUrl;

        const fetchDetail = async ({ initial = false } = {}) => {
            if (initial && !hadCachedDetail) setLoadingDetail(true);
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
                rememberDetail(orderNumber, data);
                setDetail(data);
                setDetailError('');
            } catch (err) {
                if (!aliveCheck()) return;
                // 캐시 데이터로 화면이 이미 차있으면 굳이 에러를 띄워 사용자 흐름을 끊지 않는다.
                if (initial && !hadCachedDetail) setDetailError(err.message || '오류가 발생했습니다.');
            } finally {
                if (initial && !hadCachedDetail && aliveCheck()) setLoadingDetail(false);
            }
        };

        const refreshTimer = canOpenFromCache
            ? setTimeout(() => fetchDetail(), 1500)
            : null;
        if (!canOpenFromCache) fetchDetail({ initial: true });

        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchDetail();
        };
        const onFocus = () => fetchDetail();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);

        return () => {
            alive = false;
            if (refreshTimer) clearTimeout(refreshTimer);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
        };
    }, [orderNumber]);

    // orderNumber 가 바뀌면(스와이프) detail 을 새 캐시로 교체. 새 orderNumber 에 캐시가
    // 있으면 즉시, 없으면 잠시 null → fetchDetail 이 채움.
    useEffect(() => {
        const cached = peekDetail(orderNumber);
        if (cached) {
            setDetail(cached);
            setLoadingDetail(false);
            setDetailError('');
        } else {
            setDetail(null);
            setLoadingDetail(true);
        }
    }, [orderNumber]);

    // 미리보기 URL revoke
    useEffect(() => () => {
        queued.forEach((q) => URL.revokeObjectURL(q.previewUrl));
    }, [queued]);

    // 현재 PDF 가 화면에 그려진 직후, prev/next 지시서의 detail JSON 만 백그라운드로 미리 받아
    // 메모리 캐시에 넣는다. PDF 바이트는 받지 않음 — PDF.js + 브라우저 HTTP 캐시 + SW 의 자연
    // 경로에 맡긴다. 첫 렌더 대역폭과 경합하지 않도록 pdfReady 시점까지 기다린다. 실패는 조용히 무시.
    useEffect(() => {
        if (!pdfReady || siblings.length === 0) return undefined;
        const targets = [];
        if (prevSibling) targets.push(prevSibling);
        if (nextSibling) targets.push(nextSibling);
        if (targets.length === 0) return undefined;
        let cancelled = false;
        const t = setTimeout(() => {
            if (cancelled) return;
            targets.forEach((order) => {
                prefetchSiblingByOrderNumber(BASE_URL, order);
            });
        }, 80);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [pdfReady, prevSibling, nextSibling, siblings.length]);

    const pdfFile = useMemo(() => {
        if (!detail?.worksheetPdfUrl || !orderNumber) return null;
        const version = detail.worksheetUpdatedAt || detail.worksheetPdfUrl;
        return {
            url: `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}/pdf?v=${encodeURIComponent(version)}`,
        };
    }, [detail?.worksheetPdfUrl, detail?.worksheetUpdatedAt, orderNumber]);

    useEffect(() => {
        setHighQualityRender(false);
        setQualityScale(1);
    }, [pdfFile?.url]);

    // Document 에 넘길 file 객체 — 바이트가 있으면 data 모드, 없거나 실패면 url 폴백.
    // pdf.js 는 data 의 ArrayBuffer 를 worker 로 transfer 하면서 detach 하므로,
    // 매번 .slice() 로 새 사본을 만들어 넘긴다(원본 캐시 항상 무사).
    const pdfFileForDoc = pdfFile;

    const pdfOptions = useMemo(() => ({
        canvasMaxAreaInBytes: PDF_JS_MAX_IMAGE_BYTES,
        disableFontFace: false,
        disableAutoFetch: true,
        disableStream: false,
        isOffscreenCanvasSupported: true,
        rangeChunkSize: 512 * 1024,
        useSystemFonts: true,
    }), []);

    useEffect(() => {
        setNumPages(0);
        setCurrentPage(1);
        setPageRatio(DEFAULT_PAGE_RATIO);
        setPdfReady(false);
        setPdfError('');
        setPdfViewKey((key) => key + 1);
        setRenderAttempt(0);
        setPageRotation(0);
    }, [detail?.worksheetPdfUrl]);

    // 빠른 캐시 히트 전환에선 로딩 텍스트를 표시하지 않음(깜빡임 제거). 300ms 넘게 걸리면 그제야 노출.
    useEffect(() => {
        if (pdfReady) {
            setShowSlowLoading(false);
            return undefined;
        }
        setShowSlowLoading(false);
        const t = setTimeout(() => setShowSlowLoading(true), 300);
        return () => clearTimeout(t);
    }, [pdfReady, detail?.worksheetPdfUrl]);

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
        const minDpr = highQualityRender ? PDF_DETAIL_DPR : PDF_FAST_DPR;
        const cap = Math.max(minDpr, Math.min(PDF_MAX_DPR, areaLimitedDpr));

        // Render only for the zoom tier the user actually reached. This keeps
        // the first high-quality pass light, then sharpens further after zoom.
        const targetScale = highQualityRender ? qualityScale : 1;
        const ideal = Math.min(cap, Math.max(minDpr, deviceDpr * targetScale * PDF_OVERSAMPLE));

        // 렌더 실패 회차마다 fallback factor 를 곱해 단계적으로 낮춘다.
        const factor = PDF_RENDER_FALLBACK_FACTORS[
            Math.min(renderAttempt, PDF_RENDER_FALLBACK_FACTORS.length - 1)
        ];
        // Pinch zoom needs a real minimum DPR; below this, text gets visibly soft.
        return Math.max(minDpr, ideal * factor);
    }, [highQualityRender, pageRatio, pageWidth, qualityScale, renderAttempt]);

    const onDocLoad = useCallback(({ numPages: n }) => {
        setNumPages(n);
        setCurrentPage((page) => Math.min(Math.max(1, page), n || 1));
        setPdfError('');
    }, []);

    const onDocError = useCallback((err) => {
        setPdfError(err?.message || 'PDF 를 표시할 수 없습니다.');
    }, []);

    const onPageLoad = useCallback((page) => {
        // page.rotate = PDF 자체 /Rotate 값. getViewport({scale:1}) 인자 생략 시
        // 이 값을 적용한 dim 을 돌려준다 (즉 사용자가 보는 자연 방향 기준).
        const naturalRotation = (page?.rotate ?? 0) % 360;
        const naturalVp = page.getViewport({ scale: 1 });
        if (!naturalVp?.width || !naturalVp?.height) return;
        const isLandscape = naturalVp.width > naturalVp.height;

        // 가로면 +90° 추가 — 스크린엔 portrait 으로 채워지고 사용자가 폰을
        // 좌측으로 90° 기울이면 콘텐츠가 정방향으로 읽힌다.
        const finalRotation = isLandscape
            ? (naturalRotation + 90) % 360
            : naturalRotation;

        setPageRotation((prev) => (prev === finalRotation ? prev : finalRotation));

        // 비율은 우리가 실제 그릴 회전 기준으로 — landscape 를 추가 회전해
        // portrait 가 됐으면 그 portrait 의 width/height 로 계산해야 stage fit 이 맞다.
        const finalVp = page.getViewport({ scale: 1, rotation: finalRotation });
        const nextRatio = finalVp.width / finalVp.height;
        setPageRatio((currentRatio) => (
            Math.abs(currentRatio - nextRatio) > 0.001 ? nextRatio : currentRatio
        ));
    }, []);

    // 캔버스 할당 실패/메모리 부족 등 렌더 단계 실패 — 다음 회차에 더 낮은 DPR 로
    // 자동 재시도. 마지막 폴백 단계까지 가도 안 되면 거기서 멈추고 그대로 둔다(무한루프 차단).
    const onPageRenderError = useCallback((err) => {
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.warn('[worksheet pdf render]', err?.message || err);
        }
        setRenderAttempt((a) => (
            a < PDF_RENDER_FALLBACK_FACTORS.length - 1 ? a + 1 : a
        ));
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
        if (e.target) e.target.value = '';
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
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        cameraInputRef.current?.click();
    };

    const triggerGallery = () => {
        if (compressing || uploading) return;
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        galleryInputRef.current?.click();
    };

    const handleUpload = async () => {
        if (!queued.length || uploading) return;
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        setUploading(true);
        setUploadError('');
        setUploadResult(null);
        try {
            const fd = new FormData();
            // 백엔드 evidence API 의 'department' 필드명은 그대로(uploadedDepartment 컬럼) — 의미만
            // "업로더 식별자" 로 확장돼 직원 이름이 들어간다. 관리자 모달의 표시 라벨은 동일하게 잘 동작.
            fd.append('department', worker);
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
            const uploadedCount = body.count || 0;
            setUploadResult({ count: uploadedCount });
            // 사진보기 시트의 카운트/그리드를 즉시 최신 상태로.
            refreshEvidencePhotos();
            // 업로드 직후 작업완료 흐름 — 따로 다시 [작업완료] 누르지 않아도 한 번에 끝나도록.
            // 본인이 이미 완료했거나 직원 미설정이면 묻지 않는다.
            if (!completedByMe && worker) {
                setCompleteConfirmKind('upload');
            }
        } catch (err) {
            setUploadError(err.message || '업로드 중 오류');
        } finally {
            setUploading(false);
        }
    };

    // [작업완료] — 본인 작업이 끝났음을 신고. 성공 시 다음 지시서로 자동 이동(검토 흐름 유지).
    // 다음이 없으면 이전, 둘 다 없으면 목록으로. 완료한 건은 siblings 에서 제거해 다시 잡지 않음.
    // confirm 다이얼로그는 호출 측(CompletionConfirmModal) 에서 처리한다.
    const handleWorkerComplete = async () => {
        if (completing) return;
        if (!worker) {
            setWorkerDraft('');
            setShowWorkerModal(true);
            return;
        }
        setCompleting(true);
        setCompleteError('');
        try {
            const res = await fetch(
                `${BASE_URL}/api/public/worksheets/${encodeURIComponent(orderNumber)}/worker-complete`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ worker }),
                }
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.message || '작업완료 신고에 실패했습니다.');
            }
            const filteredSiblings = siblings.filter((s) => s !== orderNumber);
            const nextOrder = nextSibling || prevSibling;
            if (nextOrder) {
                navigate(`/m/worksheets/${encodeURIComponent(nextOrder)}`, {
                    state: { siblings: filteredSiblings },
                    replace: true,
                });
            } else {
                navigate('/m/worksheets');
            }
        } catch (err) {
            setCompleteError(err.message || '작업완료 처리 중 오류');
        } finally {
            setCompleting(false);
        }
    };

    const submitWorker = () => {
        const v = (workerDraft || '').trim();
        if (!v) return;
        setWorker(v);
        setStoredWorker(v);
        setShowWorkerModal(false);
    };
    const openChangeWorker = () => {
        setWorkerDraft(worker || '');
        setShowWorkerModal(true);
    };

    const totalSize = useMemo(
        () => queued.reduce((s, q) => s + (q.file?.size || 0), 0),
        [queued]
    );

    // 본인이 이미 [작업완료] 누른 건 — 액션바의 작업완료 버튼을 회색 "완료됨" 으로 비활성.
    const completedByMe = !!worker
        && Array.isArray(detail?.workerCompletions)
        && detail.workerCompletions.some((c) => c.worker === worker);

    return (
        <div className="wsv-page">
            <header className={`wsv-topbar${chromeVisible ? '' : ' wsv-topbar-hidden'}`}>
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
                <button
                    type="button"
                    className="wsv-topbar-share"
                    onClick={shareWorksheet}
                    onTouchEnd={tapHandler(shareWorksheet)}
                    disabled={sharingWorksheet || !pdfReady}
                    aria-label="지시서 공유"
                >
                    {sharingWorksheet ? (
                        <span className="wsv-topbar-share-spinner" aria-hidden="true" />
                    ) : (
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="5" cy="10" r="2.2" />
                            <circle cx="15" cy="5" r="2.2" />
                            <circle cx="15" cy="15" r="2.2" />
                            <path d="M7 9l6-3M7 11l6 3" />
                        </svg>
                    )}
                </button>
            </header>

            {/* stage onClick — PDF 영역 한 번 탭 → 상단/하단 chrome 보임/숨김 토글.
                stage onTouchStart/End — 한 손가락 좌·우 스와이프 → 다음·이전 지시서.
                줌인 상태(scale > 1)에선 라이브러리 패닝과 충돌하지 않도록 가로채지 않음. */}
            <div
                className="wsv-stage"
                ref={stageRef}
                onClick={handleStageTap}
                onTouchStart={handleStageTouchStart}
                onTouchEnd={handleStageTouchEnd}
            >
                {loadingDetail && <div className="wsv-msg">불러오는 중…</div>}
                {!loadingDetail && detailError && <div className="wsv-msg error">{detailError}</div>}
                {!loadingDetail && !detailError && !pdfFile && (
                    <div className="wsv-msg">PDF 가 아직 등록되지 않았습니다.</div>
                )}
                {pdfFile && pageWidth > 0 && !pdfError && !pdfReady && showSlowLoading && (
                    <div className="wsv-msg wsv-pdf-loading">PDF 불러오는 중…</div>
                )}
                {pdfFile && pageWidth > 0 && (
                    <TransformWrapper
                        key={`pdf-view-${pdfViewKey}`}
                        ref={transformRef}
                        initialScale={1}
                        minScale={1}
                        maxScale={PINCH_MAX_SCALE}
                        centerOnInit
                        centerZoomedOut
                        doubleClick={{ mode: 'toggle', step: 1.4 }}
                        onTransform={(_, state) => {
                            // v4 콜백명은 onTransform (onTransformed 아님). 매 변환마다 ref 갱신.
                            currentScaleRef.current = state?.scale ?? 1;
                        }}
                        onPinchStart={(ref) => {
                            currentScaleRef.current = ref?.state?.scale ?? currentScaleRef.current;
                        }}
                        onZoomStop={(ref) => {
                            const nextScale = ref?.state?.scale ?? currentScaleRef.current;
                            currentScaleRef.current = nextScale;
                            requestPdfQualityForScale(nextScale);
                        }}
                        wheel={{
                            step: 0.18,
                            excluded: ['wsv-back', 'wsv-action-btn', 'wsv-action-photos',
                                       'wsv-action-camera', 'wsv-action-gallery',
                                       'wsv-action-complete', 'wsv-action-completed'],
                        }}
                        pinch={{ step: 5 }}
                        panning={{
                            velocityDisabled: true,
                            // 라이브러리가 window mousedown 을 듣는데, 만에 하나 버튼 영역
                            // 탭이 흘러들어가면 preventDefault 가 click 합성을 막을 수 있음.
                            // 명시적으로 제외해 라이브러리가 절대 가로채지 못하게.
                            excluded: ['wsv-back', 'wsv-action-btn', 'wsv-action-photos',
                                       'wsv-action-camera', 'wsv-action-gallery',
                                       'wsv-action-complete', 'wsv-action-completed',
                                       'wsv-action-icon', 'wsv-action-text',
                                       'wsv-action-badge', 'wsv-pager-btn'],
                        }}
                    >
                        <TransformComponent
                            wrapperClass="wsv-pdf-wrapper"
                            contentClass="wsv-pdf-content"
                        >
                            {pdfFileForDoc && (
                            <Document
                                file={pdfFileForDoc}
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
                                        // Fast first render, then sharpen only to the zoom tier the user needs.
                                        devicePixelRatio={pdfDevicePixelRatio}
                                        // 가로형 PDF 는 onPageLoad 에서 +90° 추가 회전 적용 → portrait 로 화면 채움.
                                        rotate={pageRotation}
                                        renderAnnotationLayer={false}
                                        renderTextLayer={false}
                                        onLoadSuccess={onPageLoad}
                                        onRenderError={onPageRenderError}
                                        onRenderSuccess={() => {
                                            setPdfReady(true);
                                            const upgrade = () => requestPdfQualityForScale(currentScaleRef.current);
                                            if (!highQualityRender) {
                                                if (typeof window !== 'undefined' && window.requestIdleCallback) {
                                                    window.requestIdleCallback(upgrade, { timeout: 1200 });
                                                } else {
                                                    window.setTimeout(upgrade, 700);
                                                }
                                            }
                                            if (highQualityRender) return;
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
                            )}
                        </TransformComponent>
                    </TransformWrapper>
                )}
                {pdfError && <div className="wsv-msg error">{pdfError}</div>}

                {numPages > 1 && (
                    <div
                        className={`wsv-pager${chromeVisible ? '' : ' wsv-pager-chrome-hidden'}`}
                        onClick={(e) => e.stopPropagation()}
                    >
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

            <div className={`wsv-actionbar${chromeVisible ? '' : ' wsv-actionbar-hidden'}`}>
                <button
                    type="button"
                    className="wsv-action-btn wsv-action-photos"
                    onClick={openPhotosSheet}
                    onTouchEnd={tapHandler(openPhotosSheet)}
                >
                    <span className="wsv-action-icon" aria-hidden="true">
                        <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="16" height="13" rx="2" />
                            <circle cx="8" cy="9" r="1.5" />
                            <path d="M3 14l4.5-4 4 4 3-2.5 4.5 4" />
                        </svg>
                        {evidencePhotos.length > 0 && (
                            <span className="wsv-action-badge" aria-hidden="true">
                                {evidencePhotos.length > 99 ? '99+' : evidencePhotos.length}
                            </span>
                        )}
                    </span>
                    <span className="wsv-action-text">사진보기</span>
                </button>
                <button
                    type="button"
                    className="wsv-action-btn wsv-action-camera"
                    onClick={triggerCamera}
                    onTouchEnd={tapHandler(triggerCamera)}
                    disabled={uploading || compressing}
                >
                    <span className="wsv-action-icon" aria-hidden="true">
                        <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 7.5h2.5l1.5-2h6l1.5 2H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4A1.5 1.5 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5z" />
                            <circle cx="11" cy="13" r="3.2" />
                        </svg>
                    </span>
                    <span className="wsv-action-text">사진찍기</span>
                </button>
                <button
                    type="button"
                    className="wsv-action-btn wsv-action-gallery"
                    onClick={triggerGallery}
                    onTouchEnd={tapHandler(triggerGallery)}
                    disabled={uploading || compressing}
                >
                    <span className="wsv-action-icon" aria-hidden="true">
                        <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="16" height="13" rx="2" />
                            <circle cx="8" cy="9" r="1.5" />
                            <path d="M3 14l4.5-4 4 4 3-2.5 4.5 4" />
                        </svg>
                    </span>
                    <span className="wsv-action-text">사진선택</span>
                </button>
                {completedByMe ? (
                    <div className="wsv-action-btn wsv-action-completed" aria-disabled="true">
                        <span className="wsv-action-icon" aria-hidden="true">
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 9l4 4 8-9" />
                            </svg>
                        </span>
                        <span className="wsv-action-text">완료됨</span>
                    </div>
                ) : (
                    <button
                        type="button"
                        className="wsv-action-btn wsv-action-complete"
                        onClick={() => setCompleteConfirmKind('manual')}
                        onTouchEnd={tapHandler(() => setCompleteConfirmKind('manual'))}
                        disabled={completing}
                    >
                        <span className="wsv-action-icon" aria-hidden="true">
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 9l4 4 8-9" />
                            </svg>
                        </span>
                        <span className="wsv-action-text">작업완료</span>
                    </button>
                )}
            </div>
            {completeError && <div className="wsv-toast error">{completeError}</div>}
            {worksheetShareToast && (
                <div
                    className="wsv-toast"
                    onClick={() => setWorksheetShareToast('')}
                >
                    {worksheetShareToast}
                </div>
            )}
            <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePickFiles}
                style={{ display: 'none' }}
            />
            <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handlePickFiles}
                style={{ display: 'none' }}
            />

            {/* 바닥 시트 — 업로드된 사진 보기(그리드). 탭하면 라이트박스로. */}
            {photosSheetOpen && (
                <div className="wsv-sheet-backdrop" onClick={closePhotosSheet}>
                    <div className="wsv-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="wsv-sheet-handle" />
                        <div className="wsv-sheet-head">
                            <div>
                                <div className="wsv-sheet-title">업로드된 작업 사진</div>
                                <div className="wsv-sheet-sub">
                                    {evidencePhotos.length > 0
                                        ? `${evidencePhotos.length}장 · ${orderNumber}`
                                        : orderNumber}
                                </div>
                            </div>
                            <button
                                type="button"
                                className="wsv-sheet-close"
                                onClick={closePhotosSheet}
                                aria-label="닫기"
                            >
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M4 4l8 8M12 4l-8 8" />
                                </svg>
                            </button>
                        </div>
                        {evidencePhotos.length === 0 ? (
                            <div className="wsv-photos-empty">
                                <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="6" y="10" width="36" height="28" rx="4" />
                                    <circle cx="16" cy="20" r="3" />
                                    <path d="M6 32l11-10 9 9 6-5 10 9" />
                                </svg>
                                <div className="wsv-photos-empty-title">아직 업로드된 사진이 없어요</div>
                                <div className="wsv-photos-empty-sub">
                                    [사진찍기] 또는 [사진선택] 으로 작업 사진을 업로드하면 여기 나타납니다.
                                </div>
                            </div>
                        ) : (
                            <div className="wsv-photos-grid">
                                {evidencePhotos.map((p, idx) => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        className="wsv-photos-cell"
                                        onClick={() => setLightboxIndex(idx)}
                                        aria-label={`사진 ${idx + 1}장 보기`}
                                    >
                                        <img
                                            src={`${BASE_URL}${p.imageUrl}`}
                                            alt={p.originalName || ''}
                                            loading="lazy"
                                        />
                                        {p.uploadedDepartment && (
                                            <span className="wsv-photos-cell-tag">
                                                {p.uploadedDepartment}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 라이트박스 — 사진 한 장을 풀스크린으로 + 카톡 공유 버튼 */}
            {lightboxIndex !== null && evidencePhotos[lightboxIndex] && (
                <div className="wsv-lightbox" onClick={closeLightbox}>
                    <div className="wsv-lightbox-bar" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="wsv-lightbox-btn"
                            onClick={closeLightbox}
                            aria-label="닫기"
                        >
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M4 4l10 10M14 4l-10 10" />
                            </svg>
                        </button>
                        <div className="wsv-lightbox-counter">
                            {lightboxIndex + 1} / {evidencePhotos.length}
                        </div>
                        <button
                            type="button"
                            className="wsv-lightbox-btn wsv-lightbox-share"
                            onClick={shareCurrentPhoto}
                            disabled={sharing}
                            aria-label="공유"
                        >
                            {sharing ? (
                                <span className="wsv-lightbox-spinner" aria-hidden="true" />
                            ) : (
                                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="5" cy="10" r="2.2" />
                                    <circle cx="15" cy="5" r="2.2" />
                                    <circle cx="15" cy="15" r="2.2" />
                                    <path d="M7 9l6-3M7 11l6 3" />
                                </svg>
                            )}
                            <span>공유</span>
                        </button>
                    </div>
                    <div
                        className="wsv-lightbox-stage"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <img
                            src={`${BASE_URL}${evidencePhotos[lightboxIndex].imageUrl}`}
                            alt={evidencePhotos[lightboxIndex].originalName || ''}
                        />
                    </div>
                    <div className="wsv-lightbox-pager" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="wsv-lightbox-nav"
                            onClick={() => setLightboxIndex((idx) => Math.max(0, idx - 1))}
                            disabled={lightboxIndex <= 0}
                            aria-label="이전 사진"
                        >
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M11 4L6 9l5 5" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            className="wsv-lightbox-nav"
                            onClick={() => setLightboxIndex((idx) => Math.min(evidencePhotos.length - 1, idx + 1))}
                            disabled={lightboxIndex >= evidencePhotos.length - 1}
                            aria-label="다음 사진"
                        >
                            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M7 4l5 5-5 5" />
                            </svg>
                        </button>
                    </div>
                    {shareToast && (
                        <div
                            className="wsv-lightbox-toast"
                            onClick={() => setShareToast('')}
                        >
                            {shareToast}
                        </div>
                    )}
                </div>
            )}

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
                            <span className="wsv-dept-label">담당</span>
                            <span className="wsv-dept-value">{worker || '미설정'}</span>
                            <button type="button" className="wsv-dept-change" onClick={openChangeWorker}>
                                변경
                            </button>
                        </div>

                        {compressing ? (
                            <button type="button" className="wsv-camera-btn" disabled>
                                <span>사진 처리 중…</span>
                            </button>
                        ) : (
                            <div className="wsv-pick-actions">
                                <button
                                    type="button"
                                    className="wsv-camera-btn"
                                    onClick={triggerCamera}
                                    disabled={uploading}
                                >
                                    <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M4 7.5h2.5l1.5-2h6l1.5 2H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4A1.5 1.5 0 0 1 2.5 17V9A1.5 1.5 0 0 1 4 7.5z" />
                                        <circle cx="11" cy="13" r="3.2" />
                                    </svg>
                                    <span>사진 찍기</span>
                                </button>
                                <button
                                    type="button"
                                    className="wsv-gallery-btn"
                                    onClick={triggerGallery}
                                    disabled={uploading}
                                >
                                    <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <rect x="3" y="4" width="16" height="13" rx="2" />
                                        <circle cx="8" cy="9" r="1.5" />
                                        <path d="M3 14l4.5-4 4 4 3-2.5 4.5 4" />
                                    </svg>
                                    <span>선택하기</span>
                                </button>
                            </div>
                        )}

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

            {showWorkerModal && (
                <div className="wsv-modal-backdrop" onClick={() => worker && setShowWorkerModal(false)}>
                    <div className="wsv-modal" onClick={(e) => e.stopPropagation()}>
                        <h2>내 정보 설정</h2>
                        <p className="wsv-modal-desc">
                            이 휴대폰을 쓰는 본인 이름을 선택하세요. 워처 분배함의 본인 슬롯에 꽂힌
                            지시서만 보이고, [작업완료] 누르면 같은 슬롯 동료에게서도 사라집니다.
                        </p>
                        <div className="wsv-quick-chips">
                            {ALL_WORKERS.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={`wsv-chip ${workerDraft === name ? 'active' : ''}`}
                                    onClick={() => setWorkerDraft(name)}
                                >{name}</button>
                            ))}
                        </div>
                        <div className="wsv-modal-actions">
                            {worker && (
                                <button
                                    type="button"
                                    className="wsv-modal-cancel"
                                    onClick={() => setShowWorkerModal(false)}
                                >취소</button>
                            )}
                            <button
                                type="button"
                                className="wsv-modal-confirm"
                                onClick={submitWorker}
                                disabled={!workerDraft.trim()}
                            >저장</button>
                        </div>
                    </div>
                </div>
            )}

            <CompletionConfirmModal
                open={completeConfirmKind !== null}
                description={completeConfirmKind === 'upload'
                    ? '사진 업로드가 완료됐어요. 이번 작업을 완료 처리할까요?'
                    : '이번 작업을 완료 처리할까요?'}
                busy={completing}
                onYes={() => {
                    setCompleteConfirmKind(null);
                    setSheetOpen(false);
                    handleWorkerComplete();
                }}
                onNo={() => setCompleteConfirmKind(null)}
                onClose={() => setCompleteConfirmKind(null)}
            />
        </div>
    );
}
