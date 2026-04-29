import React, { useEffect, useRef, useState } from 'react';
import './Directions.css';

const NAVER_CLIENT_ID = import.meta.env.VITE_NAVER_MAP_CLIENT_ID || '';
const NAVER_SCRIPT_ID = 'naver-maps-sdk-script';
const COMPANY_LATLNG = { lat: 37.3622577, lng: 126.9488549 };
const COMPANY_ADDRESS = '경기 군포시 공단로 193';

function loadNaverMapsSdk() {
    if (typeof window === 'undefined') return Promise.reject(new Error('NO_WINDOW'));
    if (window.naver?.maps?.Map) return Promise.resolve();
    if (!NAVER_CLIENT_ID) return Promise.reject(new Error('NO_CLIENT_ID'));

    return new Promise((resolve, reject) => {
        const existing = document.getElementById(NAVER_SCRIPT_ID);
        if (existing) {
            if (window.naver?.maps?.Map) { resolve(); return; }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error('NAVER_LOAD_FAILED')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.id = NAVER_SCRIPT_ID;
        // NCP Maps 가 최근 일부 신규 키에서 파라미터 이름을 ncpClientId → ncpKeyId 로
        // 변경하는 케이스가 있어 두 이름 모두 동봉. SDK 가 매칭되는 것 하나만 사용.
        const id = encodeURIComponent(NAVER_CLIENT_ID);
        script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpClientId=${id}&ncpKeyId=${id}`;
        script.async = true;
        script.onload = () => {
            // SDK 가 로드되어도 ncpClientId 가 잘못되면 window.naver.maps 가 안 뜨거나
            // 인증 실패 콜백이 호출됨. 둘 다 캐치.
            if (window.naver?.maps?.Map) resolve();
            else reject(new Error('NAVER_SDK_INVALID'));
        };
        script.onerror = () => reject(new Error('NAVER_LOAD_FAILED'));
        document.head.appendChild(script);
    });
}

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
    const [mapDiag, setMapDiag] = useState('');

    useEffect(() => {
        let cancelled = false;
        const isCancelled = () => cancelled;

        const fail = (where, err) => {
            const msg = err?.message || String(err) || 'unknown';
            console.error('[NaverMap]', where, err);
            setMapDiag(`${where}: ${msg}`);
            setMapState('failed');
        };

        // 인증 실패 전역 콜백 — 네이버 SDK 가 키 거부 시 호출.
        // 도메인 미등록이 가장 흔한 케이스.
        window.navermap_authFailure = function () {
            fail('네이버지도 인증 실패 (도메인 미등록 또는 Client ID 오류)', new Error('AUTH_FAILED'));
        };

        const initMap = async () => {
            if (!NAVER_CLIENT_ID) {
                fail('VITE_NAVER_MAP_CLIENT_ID 환경변수 비어있음', new Error('NO_CLIENT_ID'));
                return;
            }
            try {
                await loadNaverMapsSdk();
            } catch (err) {
                fail('SDK 로드 실패 (네트워크/스크립트 차단)', err);
                return;
            }
            if (cancelled) return;
            if (!window.naver?.maps?.Map) {
                fail('SDK 로드됨, 하지만 naver.maps.Map 정의되지 않음', new Error('NO_NAVER_MAP'));
                return;
            }

            const container = containerRef.current;
            if (!container) return;

            const ok = await waitForLayout(container, isCancelled);
            if (cancelled) return;
            if (!ok) {
                fail('컨테이너 크기 측정 실패(0×0)', new Error('NO_LAYOUT'));
                return;
            }
            if (container.firstChild) return;

            try {
                const center = new window.naver.maps.LatLng(COMPANY_LATLNG.lat, COMPANY_LATLNG.lng);
                const map = new window.naver.maps.Map(container, {
                    center,
                    zoom: 16,
                    minZoom: 8,
                    zoomControl: true,
                    zoomControlOptions: {
                        position: window.naver.maps.Position.TOP_RIGHT,
                    },
                    scaleControl: false,
                    logoControl: true,
                    mapDataControl: false,
                });
                mapRef.current = map;

                new window.naver.maps.Marker({
                    position: center,
                    map,
                    title: '(주)에이치디사인',
                });

                setMapState('ready');
            } catch (err) {
                fail('Map/Marker 생성 실패', err);
            }
        };

        initMap();

        // 회전·리사이즈 시 캔버스 크기 갱신.
        const onResize = () => {
            const map = mapRef.current;
            if (!map) return;
            try {
                if (typeof map.refresh === 'function') map.refresh(true);
            } catch { /* ignore */ }
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);

        return () => {
            cancelled = true;
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
            // 전역 콜백 정리 — 다른 페이지에서 재진입할 때 옛 fail() 가 호출되는 것 방지.
            try { delete window.navermap_authFailure; } catch { /* ignore */ }
        };
    }, []);

    return (
        <div className="directions-page">
            <h2 className="directions-title">오시는 길</h2>
            <p className="directions-subtitle">
                언제든지 방문해 주세요. 친절히 안내해 드리겠습니다.
            </p>

            <div className="directions-layout">
                <div className="directions-map-wrap">
                    <div
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
                                    {mapDiag && (
                                        <span className="directions-map-overlay-diag">{mapDiag}</span>
                                    )}
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
                </div>
            </div>
        </div>
    );
};

export default Directions;
