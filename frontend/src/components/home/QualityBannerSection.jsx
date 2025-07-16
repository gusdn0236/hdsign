import React from 'react';
import './QualityBannerSection.css';
import {Link} from "react-router-dom";

const QualityBannerSection = () => {
    return (
        <div className="quality-banner-section">
            <img src={import.meta.env.BASE_URL + "img/qualitySample.jpg"} alt="품질" className="quality-bg"/>
            <div className="quality-text">
                <h2>품질, 선택이 아닌 필수입니다</h2>
                <p>우리는 매 순간 최고의 품질을 고민합니다.</p>
                <Link to={'/gallery'} className="oval-button">
                    제품 사진 보러가기
                </Link>
            </div>
        </div>
    );
};

export default QualityBannerSection;