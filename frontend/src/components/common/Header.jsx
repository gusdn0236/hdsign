import React, { useState, useEffect } from 'react';
import './Header.css';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

function Header() {
    const [hovered, setHovered]         = useState(false);
    const [isVisible, setIsVisible]     = useState(true);
    const [lastScrollY, setLastScrollY] = useState(0);
    const [activeSubMenu, setActiveSubMenu] = useState(null);
    const { clientUser, clientLogout }  = useAuth();

    const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

    const handleScroll = () => {
        const cur = window.scrollY;
        if (cur <= 0)                          { setIsVisible(true);  setHovered(false); }
        else if (cur > lastScrollY && cur > 80){ setIsVisible(false); setHovered(false); }
        else                                   { setIsVisible(true); }
        setLastScrollY(cur);
    };

    useEffect(() => {
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, [lastScrollY]);

    const menuItems = [
        { name: '홈', path: '/' },
        { name: '회사 소개', path: '/About/Greeting', subMenu: [
            { name: '인사말',    path: '/About/Greeting'      },
            { name: '인증서',    path: '/About/Certification'  },
            { name: '부서 소개', path: '/About/Departments'    },
            { name: '보유 장비', path: '/About/Equipment'      },
            { name: '오시는 길', path: '/About/Directions'     },
        ]},
        { name: '제품 사진', path: '/Gallery/Galva', subMenu: [
            { name: '갈바채널', path: '/Gallery/Galva', subSubMenu: [
                { name: '갈바 전/후광', path: '/Gallery/Galva?tab=0' },
                { name: '갈바 오사이',  path: '/Gallery/Galva?tab=1' },
                { name: '갈바 측광',    path: '/Gallery/Galva?tab=2' },
            ]},
            { name: '스텐채널', path: '/Gallery/Stainless', subSubMenu: [
                { name: '스텐 전/후광', path: '/Gallery/Stainless?tab=0' },
                { name: '스텐 오사이',  path: '/Gallery/Stainless?tab=1' },
                { name: '스텐 측광',    path: '/Gallery/Stainless?tab=2' },
                { name: '골드스텐',     path: '/Gallery/Stainless?tab=3' },
            ]},
            { name: '에폭시채널', path: '/Gallery/Epoxy', subSubMenu: [
                { name: '갈바 에폭시', path: '/Gallery/Epoxy?tab=0' },
                { name: '스텐에폭시',  path: '/Gallery/Epoxy?tab=1' },
            ]},
            { name: '알미늄채널', path: '/Gallery/Aluminum', subSubMenu: [
                { name: '타카채널',   path: '/Gallery/Aluminum?tab=0' },
                { name: '일체형채널', path: '/Gallery/Aluminum?tab=1' },
            ]},
            { name: '아트네온', path: '/Gallery/ArtNeon', subSubMenu: [
                { name: '아크릴네온',     path: '/Gallery/ArtNeon?tab=0' },
                { name: '아크릴조각사인', path: '/Gallery/ArtNeon?tab=1' },
            ]},
            { name: '특수/기타 가공물', path: '/Gallery/Special', subSubMenu: [
                { name: '프레임간판',    path: '/Gallery/Special?tab=0' },
                { name: '지주간판',      path: '/Gallery/Special?tab=1' },
                { name: '아크릴/포맥스', path: '/Gallery/Special?tab=2' },
                { name: '고무스카시',    path: '/Gallery/Special?tab=3' },
            ]},
        ]},
        { name: '고객 지원', path: '/Support/Notice', subMenu: [
            { name: '공지사항',      path: '/Support/Notice'   },
            { name: '견적/제작문의', path: '/Support/Contact'  },
        ]},
        { name: '거래처', path: clientUser ? '/client/request' : '/client/login',
          subMenu: clientUser ? [
            { name: '작업 요청', path: '/client/request' },
            { name: '작업 현황', path: '/client/status'  },
            { name: '로그아웃',  path: '/', onClick: clientLogout },
          ] : [
            { name: '거래처 로그인', path: '/client/login' },
          ],
        },
    ];

    return (
        <header
            className={'header' + (hovered ? ' hovered' : '') + (isVisible ? '' : ' hidden')}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => { setHovered(false); setActiveSubMenu(null); }}
        >
            <div className="logo">
                <Link to="/" onClick={scrollToTop}>HDSIGN</Link>
            </div>
            <nav className="nav">
                {menuItems.map(item => (
                    <div key={item.name} className="nav-item"
                        onMouseEnter={() => { setHovered(true); setActiveSubMenu(item.name); }}>
                        <Link to={item.path}
                            onClick={item.name === '홈' ? scrollToTop : () => setActiveSubMenu(null)}>
                            {item.name}
                            {item.name === '거래처' && clientUser && <span className="client-dot" />}
                        </Link>
                        {item.subMenu && activeSubMenu === item.name && (
                            <div className="sub-menu">
                                {item.subMenu.map(sub => (
                                    <div key={sub.name} className="sub-menu-item">
                                        <Link to={sub.path} onClick={() => {
                                            if (sub.onClick) sub.onClick();
                                            setActiveSubMenu(null); setHovered(false);
                                        }}>{sub.name}</Link>
                                        {sub.subSubMenu && (
                                            <div className="sub-sub-menu">
                                                {sub.subSubMenu.map(s => (
                                                    <Link key={s.name} to={s.path}
                                                        onClick={() => { setActiveSubMenu(null); setHovered(false); }}>
                                                        {s.name}
                                                    </Link>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </nav>
            <Link to="/admin/login" className="admin-link">관리자</Link>
        </header>
    );
}

export default Header;
