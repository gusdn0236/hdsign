/* HD사인 PWA 캐시 전략
 *
 * iOS 가 홈화면 추가 시 잡아두는 "스냅샷" 캐시 때문에 신규 배포가 반영 안 되던
 * 문제를 잡기 위함. 이 SW 는 동일 origin 의 GET 요청만 가로채고 다음과 같이 처리:
 *
 *  - HTML 내비게이션 (/, /m/worksheets 등): network-first.
 *    매번 네트워크 우선으로 가져와 가장 새 chunk 해시가 박힌 index.html 을 받음.
 *    네트워크 실패 시에만 캐시로 폴백 → 오프라인에서도 마지막 본 버전이 뜸.
 *
 *  - /assets/* (Vite 가 컨텐츠 해시로 빌드하는 immutable 자산): cache-first.
 *    파일명 자체가 해시라 같은 URL 이면 같은 콘텐츠. 새 배포는 새 해시 = 새 URL
 *    이라 자동으로 별도 fetch 됨. 캐시 hit 시 네트워크 X.
 *
 *  - 그 외 같은 origin (favicon, manifest, sw.js 자기자신): network-first.
 *
 *  - 외부 origin (백엔드 Railway, R2 등): 가로채지 않음 — 브라우저 기본 처리.
 *
 * skipWaiting + clients.claim 로 새 SW 가 설치되자마자 즉시 컨트롤 인수,
 * controllerchange 이벤트가 페이지에 발사되면 자동으로 reload 해서 최신 코드 적용.
 */

// VERSION 은 SW 자체의 캐시 키. 갱신/버그픽스 후 무조건 한 단계 올려야 옛 캐시
// (옛 index.html, 옛 assets) 가 강제로 폐기되고 클라이언트가 새 버전을 잡는다.
const VERSION = 'v2';
const HTML_CACHE = 'hdsign-html-' + VERSION;
const ASSET_CACHE = 'hdsign-asset-' + VERSION;

self.addEventListener('install', () => {
    // 새 버전 SW 가 설치되면 대기 없이 즉시 활성화 단계로.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // 옛 버전 캐시 정리.
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((k) => k !== HTML_CACHE && k !== ASSET_CACHE)
                .map((k) => caches.delete(k))
        );
        // 이미 열려있는 탭들도 즉시 이 SW 가 컨트롤.
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // SPA 내비게이션 / HTML 요청 — { cache: 'reload' } 로 브라우저 HTTP 캐시와
    // CDN(GH Pages/Fastly) 엣지 캐시를 우회. 그래야 신규 배포 직후 사용자가
    // 가진 옛 index.html(옛 chunk 해시 참조) 이 더 이상 안 잡혀 청크 404 가 사라짐.
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        event.respondWith(networkFirst(req, HTML_CACHE, { cache: 'reload' }));
        return;
    }

    // Vite 빌드 산출물 (해시 파일명) — 같은 URL = 같은 콘텐츠 보장.
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(cacheFirst(req, ASSET_CACHE));
        return;
    }

    // 그 외 같은 origin 자산 (favicon, manifest 등) — network-first.
    event.respondWith(networkFirst(req, ASSET_CACHE));
});

async function networkFirst(request, cacheName, fetchOpts) {
    const cache = await caches.open(cacheName);
    try {
        // fetchOpts.cache === 'reload' 면 브라우저가 HTTP 캐시 무시 + 'Pragma:
        // no-cache' / 'Cache-Control: no-cache' 헤더를 자동 첨부 → CDN 엣지 캐시도
        // 대부분 우회. HTML 요청에 한해 사용해 항상 최신 chunk 해시 참조를 받는다.
        const response = await fetch(request, fetchOpts);
        if (response && response.ok) {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        // SPA 폴백 — 임의 경로 내비게이션이라도 캐시된 / 가 있으면 그걸로.
        if (request.mode === 'navigate') {
            const fallback = await cache.match('/');
            if (fallback) return fallback;
        }
        throw err;
    }
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
    }
    return response;
}
