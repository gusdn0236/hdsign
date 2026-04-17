import React, { useState, useEffect } from 'react';
import './Header.css';
import { Link } from 'react-router-dom';

function Header() {
  const [hovered, setHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [activeSubMenu, setActiveSubMenu] = useState(null);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleScroll = () => {
    const currentScrollY = window.scrollY;
    if (currentScrollY <= 0) {
      setIsVisible(true);
      setHovered(false);
    } else if (currentScrollY > lastScrollY && currentScrollY > 80) {
      setIsVisible(false);
      setHovered(false);
    } else {
      setIsVisible(true);
    }
    setLastScrollY(currentScrollY);
  };

  useEffect(() => {
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [lastScrollY]);

  const menuItems = [
    { name: '홈', path: '/' },
    {
      name: '회사 소개',
      path: '/About/Greeting',
      subMenu: [
        { name: '인사말', path: '/About/Greeting' },
        { name: '인증서', path: '/About/Certification' },
        { name: '부서 소개', path: '/About/Departments' },
        { name: '보유 장비', path: '/About/Equipment' },
        { name: '오시는 길', path: '/About/Directions' },
      ],
    },
    {
      name: '제품 사진',
      path: '/Gallery/Galva',
      subMenu: [
        {
          name: '갈바 간판류',
          path: '/Gallery/Galva',
          subSubMenu: [
            { name: '갈바 후광', path: '/Gallery/Galva?tab=0' },
            { name: '갈바 오사이', path: '/Gallery/Galva?tab=1' },
            { name: '갈바 캡', path: '/Gallery/Galva?tab=2' },
            { name: '일체형', path: '/Gallery/Galva?tab=3' },
          ],
        },
        {
          name: '스텐 간판류',
          path: '/Gallery/Stainless',
          subSubMenu: [
            { name: '스텐 캡', path: '/Gallery/Stainless?tab=0' },
            { name: '스텐 오사이', path: '/Gallery/Stainless?tab=1' },
            { name: '스텐 후광', path: '/Gallery/Stainless?tab=2' },
            { name: '골드 스텐', path: '/Gallery/Stainless?tab=3' },
          ],
        },
        {
          name: '에폭시 간판류',
          path: '/Gallery/Epoxy',
          subSubMenu: [
            { name: '갈바 에폭시', path: '/Gallery/Epoxy?tab=0' },
            { name: '스텐 에폭시', path: '/Gallery/Epoxy?tab=1' },
          ],
        },
        {
          name: '특수/기타 가공물',
          path: '/Gallery/Special',
          subSubMenu: [
            { name: '아크릴', path: '/Gallery/Special?tab=0' },
            { name: '포맥스', path: '/Gallery/Special?tab=1' },
            { name: '고무 스카시', path: '/Gallery/Special?tab=2' },
            { name: '시트 커팅', path: '/Gallery/Special?tab=3' },
          ],
        },
      ],
    },
    {
      name: '고객 지원',
      path: '/Support/Notice',
      subMenu: [
        { name: '공지사항', path: '/Support/Notice' },
        { name: '견적/제작문의', path: '/Support/Contact' },
      ],
    },
  ];

  const handleHeaderMouseEnter = () => setHovered(true);
  const handleHeaderMouseLeave = () => {
    setHovered(false);
    setActiveSubMenu(null);
  };

  return (
    <header
      className={
        'header' + (hovered ? ' hovered' : '') + (isVisible ? '' : ' hidden')
      }
      onMouseEnter={handleHeaderMouseEnter}
      onMouseLeave={handleHeaderMouseLeave}
    >
      <div className="logo">
        <Link to={'/'} onClick={scrollToTop}>
          HDSIGN
        </Link>
      </div>
      <nav className="nav">
        {menuItems.map(item => (
          <div
            key={item.name}
            className="nav-item"
            onMouseEnter={() => {
              setHovered(true);
              setActiveSubMenu(item.name);
            }}
          >
            <Link
              to={item.path}
              onClick={
                item.name === '홈' ? scrollToTop : () => setActiveSubMenu(null)
              }
            >
              {item.name}
            </Link>
            {item.subMenu && activeSubMenu === item.name && (
              <div className="sub-menu">
                {item.subMenu.map(subItem => (
                  <div
                    key={subItem.name}
                    className="sub-menu-item"
                    onMouseEnter={() => setActiveSubMenu(item.name)}
                  >
                    <Link
                      to={subItem.path}
                      onClick={() => {
                        setActiveSubMenu(null);
                        setHovered(false);
                      }}
                    >
                      {subItem.name}
                    </Link>
                    {subItem.subSubMenu && (
                      <div className="sub-sub-menu">
                        {subItem.subSubMenu.map(subSubItem => (
                          <Link
                            key={subSubItem.name}
                            to={subSubItem.path}
                            onClick={() => {
                              setActiveSubMenu(null);
                              setHovered(false);
                            }}
                          >
                            {subSubItem.name}
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
      </nav><Link to="/admin/login" className="admin-link">관리자</Link>
      <Link
        to="/admin/login"
        style={{
          position: 'absolute',
          right: '40px',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: '11px',
          color: '#333',
          textDecoration: 'none',
          opacity: 1,
        }}
      >
        관리자
      </Link>
    </header>
  );
}

export default Header;
