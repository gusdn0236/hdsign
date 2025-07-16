// src/components/home/TrustBannerSection.jsx
import React, {useRef} from 'react';
import './TrustBannerSection.css';
import './OvalButton.css'
import {Link} from "react-router-dom";
import {useGsapFadeUpOnScroll} from "../../hooks/useGsapFadeUpScroll.js";


const TrustBannerSection = () => {
    const titleRef = useRef(null);
    const subtitleRef = useRef(null);
    const buttonRef = useRef(null);

    useGsapFadeUpOnScroll([titleRef, subtitleRef, buttonRef]);

    return (
        <div className="trust-banner-section">
            <img src={import.meta.env.BASE_URL + "img/handshake.jpg"} alt="신뢰" className="trust-bg"/>
            <div className="trust-text">
                <h2 className={'title'} ref={titleRef}>믿음, 그 이상의 가치</h2>
                <p className={'subtitle'} ref={subtitleRef}> 고객의 기대를 뛰어넘는 'HDSIGN' 의 책임과 신뢰</p>
                <Link to={'/About'} className="oval-button" ref={buttonRef}>
                    회사 소개
                </Link>

            </div>
        </div>
    );
};


export default TrustBannerSection;