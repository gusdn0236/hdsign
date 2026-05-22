/**
 * 데모(둘러보기) 모드 가드.
 *
 * 데모 계정 토큰에는 JWT payload 에 demo:true 가 박혀 있다. 이 모듈은:
 *   1. 토큰을 디코드해 현재 세션이 데모인지 판별 (decodeJwt / isDemoToken)
 *   2. window.fetch 를 감싸, 데모 세션에서 발생하는 모든 쓰기 요청
 *      (GET/HEAD/OPTIONS 외)을 네트워크로 보내기 전에 가로채 안내 토스트를 띄운다.
 *
 * 백엔드(JwtFilter)도 동일하게 403 으로 막으므로, 이 가드는 "보안"이 아니라
 * "버튼을 눌렀을 때 깔끔한 안내를 주고 불필요한 요청을 줄이는" UX 레이어다.
 */

const API_HINT = '/api/';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// 화면 진입만으로 자동 발생하는 무해한 쓰기 호출 — 막되 토스트는 띄우지 않는다.
// 예: 관리자 발주 모달을 열면 자동으로 PUT .../viewed (열람 표시) 가 나간다.
const SILENT_PATTERNS = [/\/viewed$/];

// 로그인 요청은 데모 세션이 이미 있어도 절대 막지 않는다.
// 데모 계정 하나로 관리자·거래처 양쪽에 로그인하려면, 한쪽 데모 토큰이
// 이미 저장된 상태에서도 다른 쪽 로그인 POST 가 통과해야 하기 때문.
const EXEMPT_PATTERNS = [/\/auth\/login$/];

const TOAST_ID = 'demo-mode-toast';
const TOAST_MESSAGE = '🔒 데모 계정에서는 사용할 수 없습니다 — 둘러보기 전용입니다';

/** base64url → 문자열. 실패 시 null. */
function base64UrlDecode(segment) {
    try {
        let s = segment.replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4;
        if (pad) s += '='.repeat(4 - pad);
        return atob(s);
    } catch {
        return null;
    }
}

/** JWT 의 payload(클레임) 객체를 반환. 형식이 잘못되면 null. */
export function decodeJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = base64UrlDecode(parts[1]);
    if (!json) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

/** 데모 계정 토큰이면 true. */
export function isDemoToken(token) {
    return decodeJwt(token)?.demo === true;
}

/** 현재 활성 세션(관리자 또는 거래처) 중 하나라도 데모면 true. */
export function isDemoSessionActive() {
    try {
        if (isDemoToken(sessionStorage.getItem('adminToken'))) return true;
        if (isDemoToken(localStorage.getItem('clientToken'))) return true;
    } catch {
        /* storage 접근 불가 환경 — 무시 */
    }
    return false;
}

/** 화면 하단에 잠깐 떴다 사라지는 안내 토스트. CSS 파일 없이 자체 완결. */
let toastTimer = null;
export function showDemoToast(message = TOAST_MESSAGE) {
    if (typeof document === 'undefined' || !document.body) return;
    let el = document.getElementById(TOAST_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = TOAST_ID;
        el.setAttribute('role', 'status');
        Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            bottom: '32px',
            transform: 'translateX(-50%)',
            maxWidth: '90vw',
            padding: '12px 20px',
            background: 'rgba(24,24,27,0.96)',
            color: '#fff',
            fontSize: '14px',
            fontWeight: '600',
            lineHeight: '1.4',
            borderRadius: '10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            zIndex: '99999',
            opacity: '0',
            transition: 'opacity 0.2s ease',
            pointerEvents: 'none',
            textAlign: 'center',
        });
        document.body.appendChild(el);
    }
    el.textContent = message;
    // 강제 reflow 후 페이드인
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.style.opacity = '0';
    }, 2600);
}

/** window.fetch 를 한 번만 감싼다. main.jsx 에서 앱 시작 직후 호출. */
let installed = false;
export function installDemoGuard() {
    if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    installed = true;

    const realFetch = window.fetch.bind(window);

    window.fetch = function demoGuardedFetch(input, init) {
        try {
            const method = (
                (init && init.method) ||
                (input && typeof input === 'object' && input.method) ||
                'GET'
            ).toUpperCase();
            const url =
                typeof input === 'string'
                    ? input
                    : input && typeof input.url === 'string'
                        ? input.url
                        : '';

            const isApiWrite =
                url.includes(API_HINT) && !SAFE_METHODS.includes(method);

            if (isApiWrite && isDemoSessionActive()) {
                const path = url.split('?')[0];
                // 로그인 요청은 그대로 통과 — 데모 하나로 양쪽 로그인 허용.
                if (EXEMPT_PATTERNS.some((re) => re.test(path))) {
                    return realFetch(input, init);
                }
                const silent = SILENT_PATTERNS.some((re) => re.test(path));
                if (!silent) showDemoToast();
                // 페이지 코드가 평범한 실패로 처리하도록 400 응답을 돌려준다.
                // (403 은 거래처 API 헬퍼가 "세션 만료"로 오인하므로 일부러 400 사용)
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            demo: true,
                            message: '데모 계정에서는 사용할 수 없습니다. 둘러보기 전용입니다.',
                        }),
                        { status: 400, headers: { 'Content-Type': 'application/json' } },
                    ),
                );
            }
        } catch {
            /* 가드 내부 오류 시 원래 fetch 로 폴백 */
        }
        return realFetch(input, init);
    };
}
