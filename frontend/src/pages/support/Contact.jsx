import React, { useState } from 'react';
import './Contact.css';

const Contact = () => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText('hdno88@daum.net');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="contact-page">
            <div className="contact-card">
                <h2 className="contact-title">견적 / 제작 문의</h2>
                <p className="contact-desc">아래 이메일로 문의 주시면 빠르게 답변 드리겠습니다.</p>

                <div className="contact-email-wrap">
                    <span className="contact-email-label">이메일</span>
                    <span className="contact-email">hdno88@daum.net</span>
                    <button className="copy-btn" onClick={handleCopy}>
                        {copied ? '복사됨 ✓' : '복사'}
                    </button>
                </div>

                <div className="contact-info-list">
                    <div className="contact-item">
                        <span className="contact-label">대표번호</span>
                        <span className="contact-value">031-452-0236</span>
                    </div>
                    <div className="contact-item">
                        <span className="contact-label">주소</span>
                        <span className="contact-value">경기 군포시 공단로 193 (주)에이치디사인</span>
                    </div>
                    <div className="contact-item">
                        <span className="contact-label">사업자등록번호</span>
                        <span className="contact-value">138-81-54760</span>
                    </div>
                    <div className="contact-item">
                        <span className="contact-label">운영시간</span>
                        <span className="contact-value">평일 09:00 ~ 18:00 (주말 · 공휴일 휴무)</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Contact;