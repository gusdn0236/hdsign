import React, { useEffect } from 'react';
import './Directions.css';

const Directions = () => {
  useEffect(() => {
    const initMap = () => {
      if (!window.Tmapv2 || !window.Tmapv2.Map) return;
      const container = document.getElementById('tmap');
      if (!container || container.firstChild) return;

      const map = new window.Tmapv2.Map('tmap', {
        center: new window.Tmapv2.LatLng(37.3622577, 126.9488549),
        width: '100%',
        height: '450px',
        zoom: 16,
      });

      new window.Tmapv2.Marker({
        position: new window.Tmapv2.LatLng(37.3622577, 126.9488549),
        map: map,
        title: '(주)에이치디사인',
      });
    };

    // 이미 로드됐으면 바로 실행, 아니면 대기
    if (window.Tmapv2 && window.Tmapv2.Map) {
      initMap();
    } else {
      window.addEventListener('load', initMap);
      const timer = setInterval(() => {
        if (window.Tmapv2 && window.Tmapv2.Map) {
          clearInterval(timer);
          initMap();
        }
      }, 200);
      return () => clearInterval(timer);
    }
  }, []);

  return (
    <div className="directions-page">
      <h2 className="directions-title">오시는 길</h2>
      <p className="directions-subtitle">
        언제든지 방문해 주세요. 친절히 안내해 드리겠습니다.
      </p>

      <div className="directions-layout">
        <div className="directions-map-wrap">
          <div id="tmap" className="directions-map"></div>
        </div>

        <div className="directions-info">
          <div className="directions-info-item">
            <span className="directions-info-icon">📍</span>
            <div>
              <p className="directions-info-label">도로명 주소</p>
              <p className="directions-info-value">경기 군포시 공단로 193</p>
            </div>
          </div>
          <div className="directions-info-item">
            <span className="directions-info-icon">📍</span>
            <div>
              <p className="directions-info-label">지번 주소</p>
              <p className="directions-info-value">경기 군포시 금정동 206-1</p>
            </div>
          </div>
          <div className="directions-info-item">
            <span className="directions-info-icon">📮</span>
            <div>
              <p className="directions-info-label">우편번호</p>
              <p className="directions-info-value">15841</p>
            </div>
          </div>
          <div className="directions-info-item">
            <span className="directions-info-icon">📞</span>
            <div>
              <p className="directions-info-label">대표번호</p>
              <p className="directions-info-value">031-452-0236</p>
            </div>
          </div>
          <div className="directions-info-item">
            <span className="directions-info-icon">🕐</span>
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
