import { lazy } from 'react'

// 배포 시마다 chunk 해시가 바뀐다. 옛 index.html 을 캐싱한 사용자가 옛 chunk 를 fetch 하면
// 404 가 나면서 "Failed to fetch dynamically imported module" 로 빈 화면이 뜬다.
// 2단계 복구:
//   1차: 캐시버스터 쿼리(?_cb=ts) + navigate. SW 의 'cache: reload' HTML fetch 와 결합돼
//        대부분 케이스가 여기서 해결된다.
//   2차: SW 자체와 모든 Cache Storage 를 폐기 후 reload. 옛 SW(v1) 가 옛 index.html 을
//        들고 있어 1차 reload 가 같은 옛 chunk 해시로 돌아가는 드문 케이스 회피.
// sessionStorage 키로 단계별 가드 → 무한 새로고침 루프 방지.
const RELOAD_KEY = 'chunk-load-reloaded'
const HARD_RESET_KEY = 'chunk-load-hard-reset'
const CB_PARAM = '_cb'

function navigateWithCacheBust() {
    try {
        const url = new URL(window.location.href)
        url.searchParams.set(CB_PARAM, Date.now().toString())
        window.location.replace(url.toString())
    } catch {
        window.location.reload()
    }
}

async function nukeServiceWorkerAndCaches() {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations()
            await Promise.all(regs.map((r) => r.unregister()))
        }
    } catch { /* ignore */ }
    try {
        if ('caches' in window) {
            const keys = await caches.keys()
            await Promise.all(keys.map((k) => caches.delete(k)))
        }
    } catch { /* ignore */ }
}

export const lazyWithRetry = (factory) =>
    lazy(async () => {
        try {
            const mod = await factory()
            // 성공했으면 retry 플래그 정리 + URL 에 _cb 가 남아있으면 깨끗이 제거
            if (
                window.sessionStorage.getItem(RELOAD_KEY) ||
                window.sessionStorage.getItem(HARD_RESET_KEY)
            ) {
                window.sessionStorage.removeItem(RELOAD_KEY)
                window.sessionStorage.removeItem(HARD_RESET_KEY)
                try {
                    const cleanUrl = new URL(window.location.href)
                    if (cleanUrl.searchParams.has(CB_PARAM)) {
                        cleanUrl.searchParams.delete(CB_PARAM)
                        window.history.replaceState(null, '', cleanUrl.toString())
                    }
                } catch { /* ignore */ }
            }
            return mod
        } catch (err) {
            // 1차 — 단순 캐시버스터 reload
            if (!window.sessionStorage.getItem(RELOAD_KEY)) {
                window.sessionStorage.setItem(RELOAD_KEY, '1')
                navigateWithCacheBust()
                return { default: () => null }
            }
            // 2차 — SW + Cache Storage 폐기 후 reload
            if (!window.sessionStorage.getItem(HARD_RESET_KEY)) {
                window.sessionStorage.setItem(HARD_RESET_KEY, '1')
                await nukeServiceWorkerAndCaches()
                navigateWithCacheBust()
                return { default: () => null }
            }
            // 3차 — 그래도 실패. 진짜로 청크가 없거나 네트워크가 끊긴 상태.
            throw err
        }
    })

