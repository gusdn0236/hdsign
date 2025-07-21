import React, {useRef} from 'react';
import './ContactBannerSection.css';
import {contactImg} from "../../assets/img/index.js";
import {Link} from "react-router-dom";
import {useGsapFadeUpOnScroll} from "../../hooks/useGsapFadeUpScroll.js";

const ContactBannerSection = () => {
    const titleRef = useRef(null);
    const subtitleRef = useRef(null);
    const buttonRef = useRef(null);

    useGsapFadeUpOnScroll([titleRef, subtitleRef, buttonRef]);

    return (
        <div className="contact-banner-section">
            <img src={contactImg} alt="견적" className="contact-bg"/>
            <div className="contact-text">
                <h2 className="title" ref={titleRef}>지금, 디자인을 현실로</h2>
                <p className="subtitle" ref={subtitleRef}>지금 바로 간편하게 견적 받아보세요.</p>
                <Link to="/support/contact" className="oval-button" ref={buttonRef}>
                    견적/제작 문의
                </Link>
            </div>
        </div>
    );
};

export default ContactBannerSection;