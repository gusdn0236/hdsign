import React, {useState, useEffect} from 'react';
import './Header.css';
import {Link} from "react-router-dom";

function Header() {
    const [hovered, setHovered] = useState(false);
    const [isVisible, setIsVisible] = useState(true);
    const [lastScrollY, setLastScrollY] = useState(0);

    const handleScroll = () => {
        const currentScrollY = window.scrollY;

        if (currentScrollY <= 0) {
            setIsVisible(true);
            if (!hovered) {
                setHovered(false);
            }
        } else if (currentScrollY > lastScrollY && currentScrollY > 80) {
            setIsVisible(false);
            setHovered(false);
        } else if (currentScrollY > 0 && currentScrollY <= 80) {
            setIsVisible(true);
            setHovered(false);
        } else {
            setIsVisible(true);
            setHovered(true);
        }
        setLastScrollY(currentScrollY);
    };

    useEffect(() => {
        window.addEventListener('scroll', handleScroll);
        if (window.scrollY === 0) {
            setHovered(false);
        }
        return () => {
            window.removeEventListener('scroll', handleScroll);
        };
    }, [lastScrollY]);

    return (
        <header
            className={`header ${hovered ? 'hovered' : ''} ${isVisible ? '' : 'hidden'}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => {
                if (window.scrollY <= 0) {
                    setHovered(false);
                } else {
                    setHovered(false);
                }
            }}
        >
            <div className="logo">
                <Link to={'/'}>HDSIGN</Link>
            </div>
            <nav
                className="nav"
                onMouseEnter={() => setHovered(true)} // ✅ nav에 마우스 올리면 hovered true
                onMouseLeave={() => {
                    // nav에서 마우스가 떠날 때, header 전체의 onMouseLeave 로직과 동일하게 처리
                    if (window.scrollY <= 0) {
                        setHovered(false);
                    } else {
                        setHovered(false);
                    }
                }}
            >
                <Link to={'/'}>홈</Link>
                <Link to={'/Gallery'}>갤러리</Link>
                <Link to={'/Contact'}>문의</Link>
            </nav>
        </header>
    );
}

export default Header;