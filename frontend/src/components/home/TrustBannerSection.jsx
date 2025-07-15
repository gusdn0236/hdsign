// src/components/home/TrustBannerSection.jsx
import React from 'react';
import './TrustBannerSection.css';

const TrustBannerSection = () => {
    return (
        <div className="trust-banner-section">
            <img src="img/handshake.jpg" alt="신뢰" className="trust-bg"/>
            <div className="trust-text">
                <h2>믿음, 그 이상의 가치</h2>
                <p>고객의 기대를 뛰어넘는 'HDSIGN' 의 책임감과 품질</p>
            </div>
        </div>
    );
};

export default TrustBannerSection;