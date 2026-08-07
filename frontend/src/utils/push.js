// 지시서 변경 웹푸시 구독/해지 헬퍼.
// 3가지 모드: 'all' (전체 알림 받기) / 'mine' (내 지시서만) / 'off' (알림 끄기).
// 저장은 localStorage(사용자가 고른 모드 기억) + 서버(PushSubscriptionController, 실제 발송 대상).

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

// 공개키라 코드에 있어도 안전(개인키만 서버 환경변수로 비밀 유지).
// 배포 시 다른 값을 쓰고 싶으면 VITE_VAPID_PUBLIC_KEY 로 오버라이드 가능.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY
    || 'BLqE34a8EAddAcswEQZzSXQyAL7cHRGGlZlhYwHoiOshFwBn_Sh_nXVPNPygPC4-je3ASjJicKxCNV_SzVqYugU';

const PUSH_MODE_KEY = 'hdsign_push_mode';

export function getStoredPushMode() {
    try {
        return localStorage.getItem(PUSH_MODE_KEY) || 'off';
    } catch (e) {
        return 'off';
    }
}

function setStoredPushMode(mode) {
    try {
        if (mode === 'off') localStorage.removeItem(PUSH_MODE_KEY);
        else localStorage.setItem(PUSH_MODE_KEY, mode);
    } catch (e) { /* localStorage 불가 환경 — 무시 */ }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function isPushSupported() {
    return typeof window !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
}

// mode: 'all' | 'mine' | 'off'. worker: mode==='mine' 일 때 본인 이름.
// 반환: { ok: boolean, mode, message? }
export async function applyPushMode(mode, worker) {
    if (!isPushSupported()) {
        return { ok: false, mode: 'off', message: '이 브라우저는 알림을 지원하지 않습니다.' };
    }

    if (mode === 'off') {
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
                await fetch(`${BASE_URL}/api/public/push-subscriptions`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: sub.endpoint }),
                }).catch(() => {}); // 서버 실패해도 클라이언트 구독은 마저 해지
                await sub.unsubscribe();
            }
        } finally {
            setStoredPushMode('off');
        }
        return { ok: true, mode: 'off' };
    }

    if (mode === 'mine' && !worker) {
        return { ok: false, mode: 'off', message: '내 지시서만 알림받기는 직원 이름을 먼저 설정해야 합니다.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        setStoredPushMode('off');
        return { ok: false, mode: 'off', message: '알림 권한이 허용되지 않았습니다.' };
    }

    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });
        }

        const res = await fetch(`${BASE_URL}/api/public/push-subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...sub.toJSON(),
                mode: mode === 'mine' ? 'MINE' : 'ALL',
                worker: mode === 'mine' ? worker : null,
            }),
        });
        if (!res.ok) {
            return { ok: false, mode: 'off', message: '서버에 구독 등록을 실패했습니다.' };
        }

        setStoredPushMode(mode);
        return { ok: true, mode };
    } catch (e) {
        return { ok: false, mode: 'off', message: '알림 구독 중 오류가 발생했습니다.' };
    }
}
