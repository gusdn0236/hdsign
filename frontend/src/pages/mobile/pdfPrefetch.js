// 모바일 지시서 목록/뷰어가 공유하는 가벼운 캐시 헬퍼.
//
// 설계 원칙: PDF 자체는 미리 받지 않는다. PDF 사전 다운로드는 두 가지 이유로 효과가 없거나
// 해롭다.
//   1) sw.js 가 Range 요청은 통째로 우회(fetch(req)) 하므로, 미리 데운 byte-range 는
//      SW 캐시에 안 들어가고 PDF.js 의 실제 range 요청과 네트워크 경합만 일으킨다.
//   2) 백엔드 PublicWorksheetController 는 ?v= 가 붙은 PDF 에 long max-age + ETag 를
//      내려주므로 브라우저 HTTP 캐시가 자연스럽게 잘 먹는다. PDF.js + 브라우저 캐시 +
//      SW 의 자연 경로만 살리는 게 가장 빠르고 단순하다.
//
// 그래서 여기 남는 건 "체감 속도에 직접 기여하는 작은 것들" 만:
//   - detailCache: 목록 → 뷰어 진입 시 회사명/납기/PDF URL 을 즉시 채워 첫 화면 빈 공간 제거.
//   - prefetchSiblingByOrderNumber: 스와이프 대상의 detail JSON(1~2KB) 만 미리 받는다.
//     스와이프 직후 detail.worksheetPdfUrl 이 즉시 채워져서 PDF.js 의 첫 range 요청이
//     네트워크 왕복 1회 빨라진다.
//   - ensureApiPreconnect: API 오리진에 preconnect/dns-prefetch 를 한 번만 박아둔다.

const DETAIL_CACHE_LIMIT = 30;
const detailCache = new Map(); // orderNumber -> list item or full detail object
let preconnectedOrigin = '';

function touchLru(map, key) {
    const value = map.get(key);
    if (value === undefined) return undefined;
    map.delete(key);
    map.set(key, value);
    return value;
}

function trimLru(map, limit) {
    while (map.size > limit) {
        const first = map.keys().next().value;
        if (first === undefined) break;
        map.delete(first);
    }
}

function ensureApiPreconnect(baseUrl) {
    if (typeof document === 'undefined' || !baseUrl) return;
    let origin;
    try {
        origin = new URL(baseUrl, window.location.href).origin;
    } catch {
        return;
    }
    if (!origin || origin === preconnectedOrigin) return;
    preconnectedOrigin = origin;
    for (const rel of ['preconnect', 'dns-prefetch']) {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = origin;
        if (rel === 'preconnect') link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    }
}

export function peekDetail(orderNumber) {
    if (!orderNumber) return null;
    return touchLru(detailCache, orderNumber) ?? null;
}

export function rememberDetail(orderNumber, detail) {
    if (!orderNumber || !detail) return;
    detailCache.set(orderNumber, detail);
    trimLru(detailCache, DETAIL_CACHE_LIMIT);
}

export function rememberAllListItems(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (item?.orderNumber) rememberDetail(item.orderNumber, item);
    }
}

// 스와이프 대상의 detail JSON 만 미리 받아 메모리 캐시에 넣는다. PDF 바이트는 받지 않음 —
// PDF 는 PDF.js + 브라우저 HTTP 캐시 + SW 의 자연 경로에 맡긴다.
export async function prefetchSiblingByOrderNumber(baseUrl, orderNumber) {
    if (!orderNumber) return null;
    ensureApiPreconnect(baseUrl);
    const cached = peekDetail(orderNumber);
    if (cached) return cached;
    try {
        const res = await fetch(
            `${baseUrl}/api/public/worksheets/${encodeURIComponent(orderNumber)}`
        );
        if (!res.ok) return null;
        const data = await res.json();
        rememberDetail(orderNumber, data);
        return data;
    } catch {
        // 백그라운드 워밍 — 네트워크 실패는 조용히 무시.
        return null;
    }
}
