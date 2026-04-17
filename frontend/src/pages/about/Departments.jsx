import React, { useState } from 'react';
import './Departments.css';

const floors = [
  {
    floor: '1F',
    name: '제작부',
    color: '#2d3748',
    description: '프레임 및 트러스 제작',
    details: [
      '각종 철재 프레임 제작',
      '트러스 구조물 제작',
      '간판 기초 구조물 가공',
    ],
  },
  {
    floor: '2F',
    name: '사무실',
    color: '#3d4f62',
    description: '영업 및 관리',
    details: ['고객 상담 및 견적 안내', '제작 일정 관리', '납품 및 시공 조율'],
  },
  {
    floor: '3F',
    name: 'CNC 가공부',
    color: '#4a5568',
    description: 'CNC 정밀 가공',
    details: [
      '포맥스 CNC 가공',
      '갈바 절곡 가공',
      '갈바 레이져 가공',
      '스텐 레이져 가공',
    ],
  },
  {
    floor: '4F',
    name: '조립부',
    color: '#374151',
    description: '완조립 및 마감 작업',
    details: ['시트 작업', '완조립', '타카 잔넬', '일체형 잔넬', '에폭시 잔넬'],
  },
  {
    floor: '5F',
    name: '대표이사실 · 아크릴 가공부',
    color: '#2d3a4a',
    description: '경영 및 아크릴 특수 가공',
    details: ['대표이사실', '아크릴 정밀 가공', '특수 소재 가공'],
  },
];

const Departments = () => {
  const [activeFloor, setActiveFloor] = useState(0);

  return (
    <div className="departments-page">
      <h2 className="departments-title">층별 부서 안내</h2>
      <p className="departments-subtitle">
        에이치디사인은 층별로 전문화된 공간에서 최고의 품질을 만들어냅니다.
      </p>

      <div className="departments-layout">
        {/* 왼쪽 건물 네비게이션 */}
        <div className="building-nav">
          {[...floors].reverse().map((floor, idx) => {
            const realIdx = floors.length - 1 - idx;
            return (
              <div
                key={floor.floor}
                className={
                  'floor-btn' + (activeFloor === realIdx ? ' active' : '')
                }
                style={{
                  borderLeftColor: floor.color,
                  backgroundColor:
                    activeFloor === realIdx ? floor.color + '18' : '',
                }}
                onClick={() => setActiveFloor(realIdx)}
              >
                <span className="floor-label" style={{ color: floor.color }}>
                  {floor.floor}
                </span>
                <span className="floor-name">{floor.name}</span>
              </div>
            );
          })}
        </div>

        {/* 오른쪽 상세 내용 */}
        <div
          className="floor-detail"
          style={{ borderTopColor: floors[activeFloor].color }}
        >
          <div className="floor-detail-header">
            <span
              className="floor-detail-floor"
              style={{ color: floors[activeFloor].color }}
            >
              {floors[activeFloor].floor}
            </span>
            <h3 className="floor-detail-name">{floors[activeFloor].name}</h3>
            <p className="floor-detail-desc">
              {floors[activeFloor].description}
            </p>
          </div>
          <ul className="floor-detail-list">
            {floors[activeFloor].details.map((item, idx) => (
              <li
                key={idx}
                style={{ borderLeftColor: floors[activeFloor].color }}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default Departments;
