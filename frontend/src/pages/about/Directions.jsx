import React, { useEffect, useRef, useState } from 'react';
import './Directions.css';

const TMAP_SCRIPT_ID = 'tmap-sdk-script';
const TMAP_SCRIPT_SRC =
    'https://apis.openapi.sk.com/tmap/jsv2?version=1&appKey=tJhy9OC93A7TbwHIpW4DN9ACAP0Jaw9T55zZtBv3';
const COMPANY_LATLNG = { lat: 37.3622577, lng: 126.9488549 };
const COMPANY_ADDRESS = '경기 군포시 공단로 193';

function loadTmapSdk() {
    if (typeof window === 'undefined') return Promise.reject(new Error('NO_WINDOW'));
    if (window.Tmapv2?.Map) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const existingScript = document.getElementById(TMAP_SCRIPT_ID);
        if (existingScript) {
            if (window.Tmapv2?.Map) {
                resolve();
                return;
            }
            existingScript.addEventListener('load', () => resolve(), { once: true });
            existingScript.addEventListener('error', () => reject(new Error('TMAP_LOAD_FAILED')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.id = TMAP_SCRIPT_ID;
        script.src = TMAP_SCRIPT_SRC;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('TMAP_LOAD_FAILED'));
        document.head.appendChild(script);
    });
}

// 컨테이너가 실제 픽셀 크기를 잡을 때까지 기다림. mount 직후엔 0 인 경우가 있어
// Tmap 이 빈 캔버스(흰 화면)를 만든다.
async function waitForLayout(el, isCancelled) {
    for (let i = 0; i < 20; i++) {
        if (isCancelled()) return false;
        if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
        await new Promise((r) => setTimeout(r, 60));
    }
    return el.offsetWidth > 0 && el.offsetHeight > 0;
}

const Directions = () => {
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    const [mapState, setMapState] = useState('loading'); // loading | ready | failed

    useEffect(() => {
        let cancelled = false;
        const isCancelled = () => cancelled;

        const initMap = async () => {
            try {
                await loadTmapSdk();
                if (cancelled || !window.Tmapv2?.Map) {
                    setMapState('failed');
                    return;
                }

                const container = containerRef.current;
                if (!container) return;

                // 컨테이너 크기가 0 이면 Tmap 캔버스가 비어버린다 — 레이아웃 대기.
                const ok = await waitForLayout(container, isCancelled);
                if (cancelled) return;
                if (!ok) {
                    setMapState('failed');
                    return;
                }
                if (container.firstChild) return;

                const w = container.offsetWidth;
                const h = container.offsetHeight;

                const map = new window.Tmapv2.Map(container, {
                    center: new window.Tmapv2.LatLng(COMPANY_LATLNG.lat, COMPANY_LATLNG.lng),
                    width: w + 'px',
                    height: h + 'px',
                    zoom: 16,
                });
                mapRef.current = map;

                new window.Tmapv2.Marker({
                    position: new window.Tmapv2.LatLng(COMPANY_LATLNG.lat, COMPANY_LATLNG.lng),
                    map,
                    title: '(주)에이치디사인',
                });

                setMapState('ready');
            } catch {
                setMapState('failed');
            }
        };

        initMap();

        // 회전·리사이즈 시 Tmap 캔버스가 옛 폭에 머물러 한쪽이 흰 띠로 남는 케이스 방지.
        const onResize = () => {
            const map = mapRef.current;
            const container = containerRef.current;
            if (!map || !container) return;
            try {
                if (typeof map.resize === 'function') {
                    map.resize(container.offsetWidth, container.offsetHeight);
                } else if (typeof map.setSize === 'function') {
                    map.setSize(new window.Tmapv2.Size(container.offsetWidth, container.offsetHeight));
                }
            } catch { /* ignore */ }
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);

        return () => {
            cancelled = true;
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);

    const naverMapHref =
        `https://map.naver.com/v5/search/${encodeURIComponent(COMPANY_ADDRESS)}`;
    const kakaoMapHref =
        `https://map.kakao.com/?q=${encodeURIComponent(COMPANY_ADDRESS)}`;

    return (
        <div className="directions-page">
            <h2 className="directions-title">오시는 길</h2>
            <p className="directions-subtitle">
                언제든지 방문해 주세요. 친절히 안내해 드리겠습니다.
            </p>

            <div className="directions-layout">
                <div className="directions-map-wrap">
                    <div
                        id="tmap"
                        ref={containerRef}
                        className="directions-map"
                        aria-label="회사 위치 지도"
                    />
                    {mapState !== 'ready' && (
                        <div className={`directions-map-overlay ${mapState}`}>
                            {mapState === 'loading' ? (
                                <span className="directions-map-overlay-text">지도를 불러오는 중…</span>
                            ) : (
                                <>
                                    <span className="directions-map-overlay-text">
                                        지도를 표시할 수 없습니다.
                                    </span>
                                    <div className="directions-map-overlay-actions">
                                        <a href={naverMapHref} target="_blank" rel="noreferrer">네이버 지도</a>
                                        <a href={kakaoMapHref} target="_blank" rel="noreferrer">카카오 지도</a>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                <div className="directions-info">
                    <div className="directions-info-item">
                        <span className="directions-info-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" />
                                <circle cx="12" cy="9" r="2.5" />
                            </svg>
                        </span>
                        <div>
                            <p className="directions-info-label">도로명 주소</p>
                            <p className="directions-info-value">경기 군포시 공단로 193</p>
                        </div>
                    </div>
                    <div className="directions-info-item">
                        <span className="directions-info-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                                <path d="M3.5 9h17" />
                            </svg>
                        </span>
                        <div>
                            <p className="directions-info-label">지번 주소</p>
                            <p className="directions-info-value">경기 군포시 금정동 206-1</p>
                            <p className="directions-info-sub">우편번호 15841</p>
                        </div>
                    </div>
                    <div className="directions-info-item">
                        <span className="directions-info-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 4.5h3l1.5 4-2 1.2a12 12 0 0 0 6.8 6.8l1.2-2 4 1.5V19a1.5 1.5 0 0 1-1.6 1.5A14.5 14.5 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5z" />
                            </svg>
                        </span>
                        <div>
                            <p className="directions-info-label">대표번호</p>
                            <p className="directions-info-value">
                                <a href="tel:031-452-0236" className="directions-info-link">031-452-0236</a>
                            </p>
                        </div>
                    </div>
                    <div className="directions-info-item">
                        <span className="directions-info-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 7.5V12l3 2" />
                            </svg>
                        </span>
                        <div>
                            <p className="directions-info-label">운영시간</p>
                            <p className="directions-info-value">평일 09:00 - 18:30</p>
                            <p className="directions-info-sub">토·일·공휴일 휴무</p>
                        </div>
                    </div>

                    <div className="directions-cta-row">
                        <a href={naverMapHref} target="_blank" rel="noreferrer" className="directions-cta naver">
                            네이버 지도
                        </a>
                        <a href={kakaoMapHref} target="_blank" rel="noreferrer" className="directions-cta kakao">
                            카카오 지도
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Directions;
