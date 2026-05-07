// 모바일 지시서 뷰어용 PDF 바이트 + detail LRU 캐시.
// - 같은 지시서 재진입·좌우 스와이프 시 네트워크 0회로 즉시 표시.
// - 목록 페이지에서 상위 N개 prefetch — 사용자가 탭하기 전에 미리 받아둔다.
// - viewer 와 list 모두 import 해 동일 캐시 인스턴스를 공유한다.
//
// 메모리 보호 위해 LRU 상한:
// - PDF 바이트: 5개 (≈ 1~3MB × 5 = 5~15MB)
// - detail JSON: 30개 (객체 한 개 ≈ 2KB)

const PDF_BYTES_CACHE_LIMIT = 5;
const DETAIL_CACHE_LIMIT = 30;

const pdfBytesCache = new Map();   // versionedUrl -> Uint8Array
const detailCache = new Map();     // orderNumber -> detail object (list item 또는 full detail)

function touchLru(map, key) {
    const v = map.get(key);
    if (v === undefined) return undefined;
    map.delete(key);
    map.set(key, v);
    return v;
}

function trimLru(map, limit) {
    while (map.size > limit) {
        const first = map.keys().next().value;
        if (first === undefined) break;
        map.delete(first);
    }
}

export function buildPdfUrl(baseUrl, orderNumber, version) {
    return `${baseUrl}/api/public/worksheets/${encodeURIComponent(orderNumber)}/pdf`
        + `?v=${encodeURIComponent(version)}`;
}

export function buildThumbnailUrl(baseUrl, orderNumber) {
    return `${baseUrl}/api/public/worksheets/${encodeURIComponent(orderNumber)}/thumbnail`;
}

// 동기 조회 — 캐시 히트면 즉시 바이트 반환, LRU touch.
export function peekPdfBytes(url) {
    if (!url) return null;
    return touchLru(pdfBytesCache, url) ?? null;
}

export function hasPdfBytes(url) {
    return !!url && pdfBytesCache.has(url);
}

export async function fetchAndCachePdfBytes(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`PDF 다운로드 실패 (${res.status})`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    pdfBytesCache.set(url, bytes);
    trimLru(pdfBytesCache, PDF_BYTES_CACHE_LIMIT);
    return bytes;
}

// detail (list item 도 포함) 동기 조회. 뷰어는 이걸로 즉시 화면을 채우고
// 백그라운드에서 full detail 을 받아 갱신(stale-while-revalidate).
export function peekDetail(orderNumber) {
    if (!orderNumber) return null;
    return touchLru(detailCache, orderNumber) ?? null;
}

export function rememberDetail(orderNumber, detail) {
    if (!orderNumber || !detail) return;
    detailCache.set(orderNumber, detail);
    trimLru(detailCache, DETAIL_CACHE_LIMIT);
}

// 목록 페이지에서 — 이미 worksheetPdfUrl + worksheetUpdatedAt 가 list 응답에 있으니
// detail fetch 없이 바로 PDF 바이트를 캐시에 채운다. 실패는 조용히 무시.
export async function prefetchPdfFromItem(baseUrl, item) {
    if (!item?.orderNumber || !item?.worksheetPdfUrl) return;
    const version = item.worksheetUpdatedAt || item.worksheetPdfUrl;
    const url = buildPdfUrl(baseUrl, item.orderNumber, version);
    if (pdfBytesCache.has(url)) return;
    try { await fetchAndCachePdfBytes(url); } catch { /* 백그라운드 무시 */ }
}

// 뷰어 내 — 형제 orderNumber 만 알 때(location.state.siblings) detail 부터 받아 진행.
export async function prefetchSiblingByOrderNumber(baseUrl, orderNumber) {
    if (!orderNumber) return;
    try {
        const res = await fetch(
            `${baseUrl}/api/public/worksheets/${encodeURIComponent(orderNumber)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        rememberDetail(orderNumber, data);
        if (!data?.worksheetPdfUrl) return;
        const version = data.worksheetUpdatedAt || data.worksheetPdfUrl;
        const url = buildPdfUrl(baseUrl, orderNumber, version);
        if (pdfBytesCache.has(url)) return;
        await fetchAndCachePdfBytes(url);
    } catch { /* ignore */ }
}

// 목록 상위 N개 PDF 를 순차 prefetch — 동시 여러 다운로드로 첫 화면 렌더링 대역폭을
// 잠식하지 않도록 하나씩. 이미 캐시 안에 있으면 helper 가 즉시 반환.
export async function prefetchTopItemPdfs(baseUrl, items, count = 3) {
    if (!Array.isArray(items)) return;
    const top = items.slice(0, count);
    for (const item of top) {
        // detail 캐시도 list item 으로 채워둔다 — 뷰어 진입 시 첫 렌더 즉시 채워짐.
        if (item?.orderNumber) rememberDetail(item.orderNumber, item);
        await prefetchPdfFromItem(baseUrl, item);
    }
}

// 목록 전체 detail 캐시 채우기 — PDF 는 받지 않음. 사용자가 어떤 항목을 탭해도
// 최소한 회사명/제목/납기 등은 즉시 표시 가능.
export function rememberAllListItems(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (item?.orderNumber) rememberDetail(item.orderNumber, item);
    }
}
