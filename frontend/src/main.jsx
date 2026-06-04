import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './App';
import {installDemoGuard} from './utils/demoGuard';

// 데모(둘러보기) 계정 가드 — window.fetch 를 감싸 데모 세션의 쓰기 요청을
// 가로채 안내 토스트를 띄운다. 어떤 컴포넌트보다 먼저 설치되도록 최상단에서 호출.
installDemoGuard();

// 빌드 버전 마커 — 배포 반영 확인용. F12 콘솔에 한 줄 찍힌다(vite.config 의 define 으로 주입).
// 같은 정보가 /version.json 으로도 노출된다(브라우저/curl 확인).
console.log(
    `%c[HD사인] build ${import.meta.env.VITE_BUILD_SHA} · ${import.meta.env.VITE_BUILD_BRANCH} · ${import.meta.env.VITE_BUILD_TIME}`,
    'color:#0a9396;font-weight:700',
);

// 카톡 인앱브라우저(안드로이드 WebView 일부 빌드)는 svh/dvh 단위 처리가
// 부정확해 URL바가 들락거릴 때 viewport 단위 기반 풀스크린 섹션이 출렁인다.
// 진입 시점의 innerHeight 를 px 로 박아 (--app-vh) 메인 페이지 풀스크린
// 섹션이 한 번 측정된 사이즈로 고정되게 한다. URL바 변화로 발생하는 resize
// 는 의도적으로 listen 하지 않는다. 회전 시에만 다시 측정.
(() => {
    const setAppVh = () => {
        document.documentElement.style.setProperty('--app-vh', window.innerHeight + 'px');
    };
    setAppVh();
    window.addEventListener('orientationchange', () => {
        // 회전 직후 innerHeight 가 미반영일 수 있어 다음 프레임에서 측정.
        requestAnimationFrame(setAppVh);
    });
})();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <BrowserRouter>
        <App/>
    </BrowserRouter>
);

// Service Worker 등록 — iOS PWA(홈화면 추가) 의 스냅샷 캐시 문제 회피용.
// /sw.js 는 vite 가 public/ 을 그대로 dist 로 복사하므로 origin root 에 위치.
//
// 등록 후:
//  - 한 번 이상 페이지 방문 시 SW 가 install + activate 되어 캐시 전략 적용.
//  - 새 배포 후 사용자가 PWA 를 다시 열면, 브라우저가 sw.js 를 다시 받아 변경 감지
//    (skipWaiting 으로 즉시 활성화) → controllerchange 이벤트 발사 → 페이지 자동
//    reload → 최신 chunk 로드.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js')
            .then((reg) => {
                // 페이지가 살아있는 동안 1분마다 SW 갱신 체크. 정상 흐름 + 안전망.
                const tick = () => {
                    reg.update().catch(() => {});
                };
                setInterval(tick, 60_000);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') tick();
                });
            })
            .catch(() => { /* 등록 실패해도 앱은 정상 동작 */ });

        // 새 SW 가 컨트롤을 가져가면 자동 reload 한 번 — 그래야 기존 페이지가 새
        // chunk 를 fetch. 무한 루프 방지를 위해 한 번만 실행 가드.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            window.location.reload();
        });
    });
}
