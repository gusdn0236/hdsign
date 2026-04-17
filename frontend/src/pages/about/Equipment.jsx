import React, { useState } from 'react';
import './Equipment.css';

import tigWelder from '../../assets/img/equipment/1f/tig_welder.jpg';
import migWelder from '../../assets/img/equipment/1f/mig_welder.jpg';
import cnc1 from '../../assets/img/equipment/3f/cnc_1.jpg';
import cnc2 from '../../assets/img/equipment/3f/cnc_2.jpg';
import bendingMachine from '../../assets/img/equipment/3f/bending_machine.jpg';
import laserCutter3f from '../../assets/img/equipment/3f/laser_cutter.jpg';
import laserWelder from '../../assets/img/equipment/3f/laser_welder.jpg';
import vCutter1 from '../../assets/img/equipment/4f/v_cutter_1.jpg';
import vCutter2 from '../../assets/img/equipment/4f/v_cutter_2.jpg';
import sheetCutter from '../../assets/img/equipment/4f/sheet_cutter.jpg';
import epoxyMachine1 from '../../assets/img/equipment/4f/epoxy_machine_1.jpg';
import epoxyMachine2 from '../../assets/img/equipment/4f/epoxy_machine_2.jpg';
import laserCutter5f1 from '../../assets/img/equipment/5f/laser_cutter_1.jpg';
import laserCutter5f2 from '../../assets/img/equipment/5f/laser_cutter_2.jpg';

const floors = [
    {
        floor: '1F', name: '제작부', color: '#2d3748',
        equipments: [
            { name: 'AC/DC TIG 인버터 용접기', model: '350AD', maker: '-', image: tigWelder, image2: null, description: '아르곤 가스를 사용한 TIG 방식의 정밀 용접 장비로, 철재 프레임 및 트러스 구조물 제작에 활용됩니다.' },
            { name: '반자동 MIG 용접기', model: '-', maker: '-', image: migWelder, image2: null, description: '와이어 피더가 포함된 반자동 MIG 용접 장비로, 빠르고 균일한 용접 품질을 구현합니다.' },
        ],
    },
    {
        floor: '3F', name: 'CNC 가공부', color: '#3d4f62',
        equipments: [
            { name: 'CNC 라우터 1호', model: 'SC-1325A', maker: 'HRT', image: cnc1, image2: cnc2, description: '컴퓨터 수치 제어 방식의 정밀 가공 장비로, 포맥스 및 각종 소재의 정교한 형상 가공에 사용됩니다.' },
            { name: '갈바 절곡기', model: '-', maker: 'HRT', image: bendingMachine, image2: null, description: '갈바나이징 강판을 정밀하게 절곡하여 간판 본체 및 프레임 형상을 제작하는 전용 장비입니다.' },
            { name: '레이저 커팅기', model: '-', maker: 'HRT', image: laserCutter3f, image2: null, description: '갈바 및 스테인리스 소재를 고정밀 레이저로 커팅하는 장비입니다.' },
            { name: '레이저 용접기', model: '-', maker: 'HRT', image: laserWelder, image2: null, description: '고출력 레이저를 이용한 정밀 용접 장비로, 깔끔하고 강한 용접 품질을 구현합니다.' },
        ],
    },
    {
        floor: '4F', name: '조립부', color: '#4a5568',
        equipments: [
            { name: 'V 커팅기', model: '-', maker: 'HRT', image: vCutter1, image2: vCutter2, description: '소재 표면에 V자형 홈을 정밀하게 가공하여 깔끔한 절곡과 마감을 가능하게 하는 장비입니다.' },
            { name: '시트 커팅기', model: 'CE7000', maker: 'Graphtec', image: sheetCutter, image2: null, description: '각종 시트류를 고정밀로 커팅하여 간판 표면 마감 작업에 활용됩니다.' },
            { name: '에폭시 주입기', model: '-', maker: '-', image: epoxyMachine1, image2: epoxyMachine2, description: '에폭시 수지를 정량 주입하여 에폭시 잔넬 및 마감 작업의 품질을 균일하게 유지하는 장비입니다.' },
        ],
    },
    {
        floor: '5F', name: '아크릴 가공부', color: '#374151',
        equipments: [
            { name: '레이저 커팅기', model: '-', maker: 'HRT', image: laserCutter5f1, image2: laserCutter5f2, description: '고정밀 레이저로 아크릴 및 특수 소재를 정교하게 커팅하여 고품질의 아크릴 간판 및 특수 가공물을 제작합니다.' },
        ],
    },
];

const Equipment = () => {
    const [activeFloor, setActiveFloor] = useState(0);
    const [modalImg, setModalImg] = useState(null);

    const openModal = (src) => setModalImg(src);
    const closeModal = () => setModalImg(null);

    React.useEffect(() => {
        const handleKey = (e) => { if (e.key === 'Escape') closeModal(); };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, []);

    return (
        <div className="equipment-page">
            <h2 className="equipment-title">보유 장비</h2>
            <p className="equipment-subtitle">에이치디사인은 층별 전문 장비를 통해 최고의 품질을 실현합니다.</p>

            <div className="equipment-layout">
                <div className="equipment-nav">
                    {[...floors].reverse().map((floor, idx) => {
                        const realIdx = floors.length - 1 - idx;
                        return (
                            <div
                                key={floor.floor}
                                className={'equip-floor-btn' + (activeFloor === realIdx ? ' active' : '')}
                                style={{ borderLeftColor: floor.color, backgroundColor: activeFloor === realIdx ? floor.color + '18' : '' }}
                                onClick={() => setActiveFloor(realIdx)}
                            >
                                <span className="equip-floor-label" style={{ color: floor.color }}>{floor.floor}</span>
                                <span className="equip-floor-name">{floor.name}</span>
                            </div>
                        );
                    })}
                </div>

                <div className="equipment-detail" style={{ borderTopColor: floors[activeFloor].color }}>
                    <div className="equipment-detail-header">
                        <span className="equip-detail-floor" style={{ color: floors[activeFloor].color }}>{floors[activeFloor].floor}</span>
                        <h3 className="equip-detail-name">{floors[activeFloor].name}</h3>
                    </div>
                    <div className="equip-cards">
                        {floors[activeFloor].equipments.map((equip, idx) => (
                            <div className="equip-card" key={idx} style={{ borderTopColor: floors[activeFloor].color }}>
                                <div className="equip-card-body">
                                    <div className="equip-card-images">
                                        {equip.image && (
                                            <div className="equip-card-img-wrap" onClick={() => openModal(equip.image)}>
                                                <img src={equip.image} alt={equip.name} className="equip-card-img" />
                                                <div className="equip-img-overlay"><span>🔍</span></div>
                                            </div>
                                        )}
                                        {equip.image2 && (
                                            <div className="equip-card-img-wrap" onClick={() => openModal(equip.image2)}>
                                                <img src={equip.image2} alt={equip.name + ' 2'} className="equip-card-img" />
                                                <div className="equip-img-overlay"><span>🔍</span></div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="equip-card-info">
                                        <div className="equip-card-header">
                                            <h4 className="equip-card-name">{equip.name}</h4>
                                            <div className="equip-card-tags">
                                                {equip.model !== '-' && <span className="equip-card-model">{equip.model}</span>}
                                                {equip.maker !== '-' && <span className="equip-card-maker" style={{ backgroundColor: floors[activeFloor].color }}>{equip.maker}</span>}
                                            </div>
                                        </div>
                                        <p className="equip-card-desc">{equip.description}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* 이미지 모달 */}
            {modalImg && (
                <div className="equip-modal" onClick={closeModal}>
                    <button className="equip-modal-close" onClick={closeModal}>✕</button>
                    <div className="equip-modal-content" onClick={(e) => e.stopPropagation()}>
                        <img src={modalImg} alt="장비 확대" />
                    </div>
                </div>
            )}
        </div>
    );
};

export default Equipment;
