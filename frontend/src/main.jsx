import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './App';

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
