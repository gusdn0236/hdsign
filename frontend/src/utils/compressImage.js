// 모바일 사진 업로드 전 압축 — 갤럭시 고화소(50~200MP) 사진의 안드로이드 OOM 방지가 핵심.
//
// 기존 방식은 createImageBitmap 으로 "원본 해상도를 통째로" RGBA 디코드한 뒤에야 캔버스에서
// 축소했다. 108MP 사진이면 디코드 버퍼만 ~432MB → 안드로이드 크롬/삼성인터넷이 탭 메모리
// 상한을 넘겨 "메모리가 부족하여 이전 작업을 완료할 수 없습니다" 로 죽었다(아이폰은 RAM·메모리
// 관리가 관대해 버팀). 게다가 WorksheetViewer 는 PDF 거대 캔버스(수백 MB)가 이미 떠 있어 더
// 잘 터졌다.
//
// 해결: (1) JPEG/PNG 헤더만 읽어 원본 치수를 "디코드 없이" 파악하고, (2) createImageBitmap 의
// resize 옵션으로 디코드와 동시에 축소해 풀해상도 중간 버퍼를 만들지 않는다. (3) 그래도 실패하면
// 더 작은 치수로 단계적 재시도. 최종 출력 치수/품질은 종전과 동일하므로 화질 변화는 없다.

const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.82;
// OOM 시 단계적으로 낮춰 재시도할 긴 변(px) 상한들. 첫 단계가 종전과 동일한 화질.
const DIM_STEPS = [COMPRESS_MAX_DIM, 1200, 900];

// 파일 헤더(앞부분)만 슬라이스해 원본 픽셀 치수를 읽는다 — 전체 디코드 없이.
// resize 옵션의 resizeWidth/Height 는 "EXIF 회전 적용 전(raw)" 좌표계라, 헤더가 주는 raw
// 치수를 그대로 쓰면 된다(스펙: resize → 그 다음 orientation 순서).
async function readRawSize(file) {
    let buf;
    try {
        buf = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    } catch {
        return null;
    }
    // JPEG: SOF0~SOF15 마커(0xC0~0xCF, 단 C4/C8/CC 제외)에 높이·너비가 담긴다.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) { i++; continue; }
            const marker = buf[i + 1];
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2; // 길이 필드 없는 마커
                continue;
            }
            const len = (buf[i + 2] << 8) | buf[i + 3];
            const isSOF = marker >= 0xc0 && marker <= 0xcf
                && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSOF) {
                const height = (buf[i + 5] << 8) | buf[i + 6];
                const width = (buf[i + 7] << 8) | buf[i + 8];
                if (width > 0 && height > 0) return { width, height };
                return null;
            }
            if (len < 2) return null;
            i += 2 + len;
        }
        return null;
    }
    // PNG: IHDR(고정 오프셋 16~23)에 너비·높이.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
        if (width > 0 && height > 0) return { width, height };
    }
    return null;
}

function targetDims(rawW, rawH, cap) {
    const longest = Math.max(rawW, rawH);
    const scale = longest > cap ? cap / longest : 1;
    return {
        w: Math.max(1, Math.round(rawW * scale)),
        h: Math.max(1, Math.round(rawH * scale)),
    };
}

async function encode(bitmap, file) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return null; }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY));
    // 캔버스 메모리 즉시 회수 힌트(다음 사진 처리 전 압박 완화).
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
    if (blob.size >= file.size) return file; // 이미 더 작으면 원본 유지
    const baseName = (file.name || 'photo').replace(/\.[^/.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}

export async function compressImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;

    const raw = await readRawSize(file);

    if (raw) {
        // 빠른 경로: 헤더로 치수를 알았으니 디코드와 동시에 축소. OOM 시 더 작게 재시도.
        for (const cap of DIM_STEPS) {
            const { w, h } = targetDims(raw.width, raw.height, cap);
            let bitmap;
            try {
                bitmap = await createImageBitmap(file, {
                    imageOrientation: 'from-image',
                    resizeWidth: w,
                    resizeHeight: h,
                    resizeQuality: 'high',
                });
            } catch {
                continue; // 이 치수 디코드 실패 → 다음 단계로 더 작게
            }
            try {
                const out = await encode(bitmap, file);
                if (out) return out;
            } catch {
                bitmap.close?.();
            }
        }
        return file; // 모든 단계 실패 → 원본(상위에서 업로드 시도/안내)
    }

    // 폴백: 헤더를 못 읽음(HEIF 등). 종전 방식 — 전체 디코드 후 캔버스 축소.
    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        return file;
    }
    const { w, h } = targetDims(bitmap.width, bitmap.height, COMPRESS_MAX_DIM);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob || blob.size >= file.size) return file;
    const baseName = (file.name || 'photo').replace(/\.[^/.]+$/, '') || 'photo';
    return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}
