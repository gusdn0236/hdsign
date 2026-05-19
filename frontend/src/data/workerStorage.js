// 휴대폰 단말 단위 "이 폰의 본인 이름" 영속화.
// 모바일 지시서 뷰어/목록, QR 카메라, 현장 뷰어가 동일 키를 공유한다.
//
// 왜 cookie 까지 같이 쓰는가:
//   - localStorage 만 쓰면 iOS Safari ITP(Intelligent Tracking Prevention)가 며칠간
//     사이트를 안 들어간 경우 / 인앱 브라우저(카톡, QR 스캐너 등)로 열린 경우
//     storage 가 비어 보여, QR 스캔 때마다 담당자 선택 모달이 다시 뜨는 문제 발생.
//   - 같은 값으로 1년 만료 first-party cookie 를 같이 박아두면 ITP 7-day window 와
//     일부 인앱 환경에서도 살아남는다. 읽을 때 localStorage → cookie 순으로 fallback,
//     cookie 에서 회수되면 localStorage 를 즉시 다시 채워 자가복구.

export const WORKER_KEY = 'hdsign_uploader_worker';

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365; // 1년

function readCookie(name) {
    if (typeof document === 'undefined' || !document.cookie) return '';
    const parts = document.cookie.split(';');
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq).trim();
        if (k !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

function writeCookie(name, value) {
    if (typeof document === 'undefined') return;
    const secure = typeof window !== 'undefined' && window.location?.protocol === 'https:'
        ? '; Secure'
        : '';
    if (value) {
        document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${COOKIE_MAX_AGE_SEC}; path=/; SameSite=Lax${secure}`;
    } else {
        document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax${secure}`;
    }
}

export function getStoredWorker() {
    let ls = '';
    try {
        ls = (localStorage.getItem(WORKER_KEY) || '').trim();
    } catch { /* private mode / disabled */ }
    if (ls) return ls;

    // localStorage 가 비어있으면 cookie 폴백. 회수되면 localStorage 도 다시 채워
    // 다음 호출부터는 빠르게 localStorage 에서 읽히도록(자가복구).
    const ck = readCookie(WORKER_KEY).trim();
    if (ck) {
        try { localStorage.setItem(WORKER_KEY, ck); } catch { /* ignore */ }
        return ck;
    }
    return '';
}

export function setStoredWorker(value) {
    const v = (value || '').trim();
    try {
        if (v) localStorage.setItem(WORKER_KEY, v);
        else localStorage.removeItem(WORKER_KEY);
    } catch { /* ignore */ }
    writeCookie(WORKER_KEY, v);
}
