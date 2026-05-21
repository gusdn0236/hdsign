// 이미지(작업 사진 · 지시서) 를 카카오톡으로 공유 — 단말 환경에 맞춰 자동 분기.
//   · 휴대폰/태블릿(pointer:coarse) → Web Share API 공유 시트 → 카카오톡 선택.
//   · PC                          → 이미지를 클립보드에 복사 → 카톡 PC 대화창에 Ctrl+V.
//   · 위 경로가 막히면             → 이미지 파일 다운로드(수동 첨부).
// 반환값으로 어떤 경로를 탔는지 알려, 호출부가 토스트 문구를 정한다.
//   'shared'(공유 시트) | 'copied'(클립보드) | 'downloaded'(다운로드)
//   | 'aborted'(사용자가 공유 취소) | 'error'(이미지 준비 실패)

// 클립보드 PNG 의 긴 변 상한 — 카톡 붙여넣기엔 충분하고 용량은 절제(원본 그대로면 수십 MB).
const CLIPBOARD_MAX_EDGE = 2400;

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        try {
            canvas.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환 실패'))),
                type,
                quality,
            );
        } catch (err) {
            reject(err);
        }
    });
}

// drawable(<canvas> 또는 ImageBitmap) 을 긴 변 CLIPBOARD_MAX_EDGE 이하로 줄여 PNG blob 생성.
// 클립보드 이미지 쓰기는 브라우저가 PNG 만 안정적으로 지원하므로 항상 PNG 로 만든다.
async function toClipboardPng(drawable, srcW, srcH) {
    const ratio = Math.min(1, CLIPBOARD_MAX_EDGE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * ratio));
    const h = Math.max(1, Math.round(srcH * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, w, h);
    return canvasToBlob(canvas, 'image/png');
}

// source 를 <canvas> 로 변환 — 캔버스·PDF 소스만 해당. URL 소스는 null 을 반환(아래에서 fetch).
async function sourceToCanvas(source) {
    if (source.type === 'canvas') return source.canvas;
    if (source.type === 'pdf') {
        // 목록 카드용 — PDF 1페이지를 즉석 렌더. pdfjs 는 필요할 때만 동적 로드.
        const { renderPdfPageToCanvas } = await import('./renderPdfPage.js');
        return renderPdfPageToCanvas(source.url, { page: source.page || 1 });
    }
    return null;
}

// source → JPEG blob (Web Share · 다운로드용).
async function loadJpegBlob(source) {
    const canvas = await sourceToCanvas(source);
    if (canvas) return canvasToBlob(canvas, 'image/jpeg', 0.92);
    const res = await fetch(source.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('이미지를 불러오지 못했습니다.');
    return res.blob();
}

// source → 클립보드용 PNG blob.
async function loadClipboardPng(source) {
    const canvas = await sourceToCanvas(source);
    if (canvas) return toClipboardPng(canvas, canvas.width, canvas.height);
    const res = await fetch(source.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('이미지를 불러오지 못했습니다.');
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    try {
        return await toClipboardPng(bitmap, bitmap.width, bitmap.height);
    } finally {
        bitmap.close?.();
    }
}

function triggerDownload(blob, fileName) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// 주 포인팅 장치가 손가락이면(휴대폰·태블릿) true. 마우스/트랙패드 PC 는 false.
function isCoarsePointer() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * 이미지를 카카오톡으로 공유.
 * @param {{type:'url',url:string}|{type:'canvas',canvas:HTMLCanvasElement}|{type:'pdf',url:string,page?:number}} source
 * @param {string} fileName  공유/다운로드 파일명 (확장자 포함)
 * @returns {Promise<'shared'|'copied'|'downloaded'|'aborted'|'error'>}
 */
export async function shareImage(source, fileName) {
    const coarse = isCoarsePointer();

    // PC — 클립보드 우선. ClipboardItem 에 Promise(loadClipboardPng) 를 넘겨, 이미지
    // 변환이 끝나기 전에 write() 가 호출되도록 한다 → 사용자 제스처가 만료되지 않는다.
    if (!coarse && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        try {
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': loadClipboardPng(source) }),
            ]);
            return 'copied';
        } catch (err) {
            if (err?.name === 'AbortError') return 'aborted';
            // 권한 거부 · 창 비활성 · 변환 실패 → 아래 다운로드 폴백으로.
        }
    }

    let blob;
    try {
        blob = await loadJpegBlob(source);
    } catch {
        return 'error';
    }

    // 휴대폰/태블릿 — Web Share 공유 시트(카카오톡 선택).
    if (coarse) {
        const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
        if (navigator.canShare?.({ files: [file] })) {
            try {
                await navigator.share({ files: [file] });
                return 'shared';
            } catch (err) {
                if (err?.name === 'AbortError') return 'aborted';
                // 공유 실패 → 다운로드 폴백.
            }
        }
    }

    triggerDownload(blob, fileName);
    return 'downloaded';
}

// 파일명에 못 쓰는 문자 제거 + 길이 제한. 이미지 확장자가 없으면 fallbackExt 를 붙인다.
export function safeFileName(base, fallbackExt = 'jpg') {
    const cleaned = String(base || '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .trim()
        .slice(0, 90);
    const name = cleaned || 'image';
    return /\.(jpe?g|png|webp|gif)$/i.test(name) ? name : `${name}.${fallbackExt}`;
}
