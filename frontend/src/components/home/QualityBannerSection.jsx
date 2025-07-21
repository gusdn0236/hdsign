import React, {useRef} from 'react';
import './QualityBannerSection.css';
import {Link} from "react-router-dom";
import {useGsapFadeUpOnScroll} from "../../hooks/useGsapFadeUpScroll.js";
import {qualityImg} from "../../assets/img/index.js";

const QualityBannerSection = () => {
    const titleRef = useRef(null);
    const subtitleRef = useRef(null);
    const buttonRef = useRef(null);

    useGsapFadeUpOnScroll([titleRef, subtitleRef, buttonRef]);


    return (
        <div className="quality-banner-section">
            <img src={qualityImg} alt="품질" className="quality-bg"/>
            <div className="quality-text">
                <h2 className={'title'} ref={titleRef}>품질, 선택이 아닌 필수입니다</h2>
                <p className={'subtitle'} ref={subtitleRef}>우리는 매 순간 최고의 품질을 고민합니다.</p>
                <Link to={'/Gallery/Galva'} className="oval-button" ref={buttonRef}>
                    제품 사진 보러가기
                </Link>
            </div>
        </div>
    );
};

export default QualityBannerSection;