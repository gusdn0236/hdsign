import React from "react";
import './Footer.css';

const Footer = () => {
    const currentYear = (new Date()).getFullYear();

    // 맨 위로 스크롤하는 함수
    const scrollToTop = () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth' // 부드러운 스크롤 효과
        });
    };

    return (
        <footer className="footer">
            <div className="footer-content-wrapper">
                {/* 왼쪽 콘텐츠 그룹 */}
                <div className="footer-left-content">
                    <p className="company-name">© {currentYear} (주)에이치디사인</p>
                    <p className="contact-info">대표번호: 031-452-0236 | 사업자등록번호: 138-81-54760</p>
                    <p className="address-info">주소: (도로명) 경기 군포시 공단로 193 (주)에이치디사인</p>
                    <p className="address-detail">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(지번)
                        경기 군포시 금정동 206-1 / 우편번호: 15841</p>
                </div>

                {/* 오른쪽 콘텐츠 그룹 (슬로건 및 버튼 추가) */}
                <div className="footer-right-content">
                    <p className="footer-slogan">"간판 제작의 새로운 기준, HDSIGN"</p>
                    {/* 맨 위로 버튼 추가 */}
                    <button onClick={scrollToTop} className="back-to-top-button" title="맨 위로">
                        ↑ 맨 위로
                    </button>
                </div>
            </div>
        </footer>
    );
};

export default Footer;