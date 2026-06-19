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

// APP1(0xFFE1) 의 EXIF IFD0 에서 Orientation(0x0112, 1~8)을 읽는다. 없으면 1.
// segStart=APP1 페이로드 시작(길이 필드 다음), segEnd=페이로드 끝(둘 다 buf 인덱스).
function parseExifOrientation(buf, segStart, segEnd) {
    let p = segStart;
    // "Exif\0\0"
    if (p + 6 > segEnd
        || buf[p] !== 0x45 || buf[p + 1] !== 0x78 || buf[p + 2] !== 0x69
        || buf[p + 3] !== 0x66 || buf[p + 4] !== 0x00 || buf[p + 5] !== 0x00) {
        return 1;
    }
    const tiff = p + 6; // TIFF 헤더 시작(모든 오프셋의 기준점)
    if (tiff + 8 > segEnd) return 1;
    const little = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49; // 'II'
    const big = buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d;    // 'MM'
    if (!little && !big) return 1;
    const u16 = (o) => (little ? (buf[o] | (buf[o + 1] << 8)) : ((buf[o] << 8) | buf[o + 1]));
    const u32 = (o) => (little
        ? ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0)
        : (((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0));
    const ifd0 = tiff + u32(tiff + 4);
    if (ifd0 + 2 > segEnd) return 1;
    const count = u16(ifd0);
    for (let k = 0; k < count; k++) {
        const entry = ifd0 + 2 + k * 12;
        if (entry + 12 > segEnd) break;
        if (u16(entry) === 0x0112) { // Orientation 태그(값=SHORT, value 필드에 인라인)
            const val = u16(entry + 8);
            return (val >= 1 && val <= 8) ? val : 1;
        }
    }
    return 1;
}

// 파일 헤더(앞부분)만 슬라이스해 원본 픽셀 치수 + EXIF orientation 을 읽는다 — 전체 디코드 없이.
// 치수는 raw(회전 전) 좌표계. orientation 5~8 이면 화면에 보이는 가로·세로가 raw 와 뒤바뀐다.
// ⚠️ resizeWidth/Height 는 안드로이드 크롬/삼성인터넷(Blink)에서 "EXIF 회전이 적용된(화면)"
//    좌표계로 해석된다(orientation 먼저, resize 나중). 그래서 raw 치수를 그대로 넘기면 세로
//    사진(orientation 6/8)이 가로 박스로 찌그러진다. 호출부는 반드시 orientation 으로 화면
//    치수를 구해 넘겨야 한다.
async function readRawMeta(file) {
    let buf;
    try {
        buf = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    } catch {
        return null;
    }
    // JPEG: SOF0~SOF15 마커(0xC0~0xCF, 단 C4/C8/CC 제외)에 높이·너비가 담긴다.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        let orientation = 1; // EXIF APP1 은 표준상 SOI 직후·SOF 이전 → SOF 도달 전에 잡힌다.
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) { i++; continue; }
            const marker = buf[i + 1];
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2; // 길이 필드 없는 마커
                continue;
            }
            const len = (buf[i + 2] << 8) | buf[i + 3];
            if (marker === 0xe1) { // APP1 — EXIF orientation 추출
                orientation = parseExifOrientation(buf, i + 4, Math.min(buf.length, i + 2 + len));
            }
            const isSOF = marker >= 0xc0 && marker <= 0xcf
                && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSOF) {
                const height = (buf[i + 5] << 8) | buf[i + 6];
                const width = (buf[i + 7] << 8) | buf[i + 8];
                if (width > 0 && height > 0) return { width, height, orientation };
                return null;
            }
            if (len < 2) return null;
            i += 2 + len;
        }
        return null;
    }
    // PNG: IHDR(고정 오프셋 16~23)에 너비·높이. PNG 는 EXIF 회전 없음(orientation=1).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
        if (width > 0 && height > 0) return { width, height, orientation: 1 };
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

    const raw = await readRawMeta(file);

    if (raw) {
        // orientation 5~8 은 화면에서 가로·세로가 raw 와 뒤바뀐다. Blink 는 resize 를 화면
        // 좌표계로 적용하므로, raw 가 아니라 "화면(회전 후)" 치수로 목표를 잡아야 비율이 보존된다.
        const swap = raw.orientation >= 5 && raw.orientation <= 8;
        const dispW = swap ? raw.height : raw.width;
        const dispH = swap ? raw.width : raw.height;
        // 빠른 경로: 헤더로 치수를 알았으니 디코드와 동시에 축소. OOM 시 더 작게 재시도.
        for (const cap of DIM_STEPS) {
            const { w, h } = targetDims(dispW, dispH, cap);
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
