import React, {useState, useEffect} from 'react';
import './Header.css';
import {Link} from "react-router-dom";

function Header() {
    const [hovered, setHovered] = useState(false);
    const [isVisible, setIsVisible] = useState(true);
    const [lastScrollY, setLastScrollY] = useState(0);
    // ⭐ 새로 추가된 상태: 현재 호버된 1차 메뉴 (null 또는 메뉴 이름) ⭐
    const [activeSubMenu, setActiveSubMenu] = useState(null);

    // 맨 위로 스크롤하는 함수
    const scrollToTop = () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth' // 부드러운 스크롤 효과
        });
    };

    const handleScroll = () => {
        const currentScrollY = window.scrollY;

        // 헤더 가시성 로직 (기존 유지)
        if (currentScrollY <= 0) {
            setIsVisible(true);
            setHovered(false); // 스크롤이 맨 위에 있으면 hovered false로 초기화
        } else if (currentScrollY > lastScrollY && currentScrollY > 80) {
            setIsVisible(false);
            setHovered(false); // 숨겨질 때 hovered도 false
        } else {
            setIsVisible(true);
            // 스크롤이 0이 아니지만, 올라가는 중이거나 특정 위치에 도달하면 hovered 유지
            // (마우스가 올라갔을 때만 hovered true가 되도록 기존 로직 유지)
        }
        setLastScrollY(currentScrollY);
    };

    useEffect(() => {
        window.addEventListener('scroll', handleScroll);
        return () => {
            window.removeEventListener('scroll', handleScroll);
        };
    }, [lastScrollY]); // lastScrollY가 변경될 때마다 effect 재실행

    // ⭐ 메뉴 데이터 정의 ⭐
    const menuItems = [
        {
            name: '홈', path: '/'
        },
        {
            name: '회사 소개',
            path: '/About/Greeting',
            subMenu: [
                {name: '인사말', path: '/About/Greeting'},
                {name: '인증서', path: '/About/Certification'},
                {name: '부서 소개', path: '/About/Departments'},
                {name: '보유 장비', path: '/About/Equipment'},
                {name: '오시는 길', path: '/About/Directions'},
            ],
        },
        {
            name: '제품 사진',
            path: '/Gallery/Galva',
            subMenu: [
                {
                    name: '갈바 간판류', path: '/Gallery/Galva',
                    subSubMenu: [
                        {name: '갈바 후광', path: '/Gallery/Galva/HaloLit'},
                        {name: '갈바 오사이', path: '/Gallery/Galva/Osai'},
                        {name: '갈바 캡', path: '/Gallery/Galva/Cap'},
                        {name: '일체형', path: '/Gallery/Galva/Integrated'},
                    ]
                },
                {
                    name: '스텐 간판류', path: '/Gallery/Stainless',
                    subSubMenu: [
                        {name: '스텐 캡', path: '/Gallery/Stainless/Cap'},
                        {name: '스텐 오사이', path: '/Gallery/Stainless/Osai'},
                        {name: '스텐 후광', path: '/Gallery/Stainless/HaloLit'},
                        {name: '골드 스텐', path: '/Gallery/Stainless/Gold'},
                    ]
                },
                {
                    name: '에폭시 간판류', path: '/Gallery/Epoxy',
                    subSubMenu: [
                        {name: '갈바 에폭시', path: '/Gallery/Epoxy/Galva'},
                        {name: '스텐 에폭시', path: '/Gallery/Epoxy/Stainless'},
                    ]
                },
                {
                    name: '특수/기타 가공물', path: '/Gallery/Special',
                    subSubMenu: [
                        {name: '아크릴', path: '/Gallery/Special/Acrylic'},
                        {name: '포맥스', path: '/Gallery/Special/Foamex'},
                        {name: '고무 스카시', path: '/Gallery/Special/Rubber'},
                        {name: '시트 커팅', path: '/Gallery/Special/SheetCutting'},
                    ]
                },
            ],
        },
        {
            name: '고객 지원',
            path: '/Support/Notice',
            subMenu: [
                {name: '공지사항', path: '/Support/Notice'},
                {name: '견적/제작문의', path: '/Support/Contact'},
            ],
        },
    ];

    // 헤더 전체에 대한 마우스 이벤트 핸들러
    const handleHeaderMouseEnter = () => {
        setHovered(true);
    };

    const handleHeaderMouseLeave = () => {
        if (window.scrollY <= 0) {
            setHovered(false);
        } else {
            setHovered(false); // 스크롤 내려갔을 때도 마우스 떠나면 배경 사라지게
        }
        setActiveSubMenu(null); // ⭐ 마우스가 헤더를 떠나면 모든 서브 메뉴 닫기 ⭐
    };


    return (
        <header
            className={`header ${hovered ? 'hovered' : ''} ${isVisible ? '' : 'hidden'}`}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
        >
            <div className="logo">
                <Link to={'/'} onClick={scrollToTop}>HDSIGN</Link>
            </div>
            <nav className="nav">
                {menuItems.map((item) => (
                    <div
                        key={item.name}
                        className="nav-item"
                        onMouseEnter={() => {
                            setHovered(true); // 메뉴 아이템에 호버 시 헤더 배경 활성화
                            setActiveSubMenu(item.name); // 현재 호버된 1차 메뉴 이름 저장
                        }}
                        onMouseLeave={() => {
                            // activeSubMenu를 null로 직접 바꾸지 않음.
                            // 헤더 전체 onMouseLeave에서 일괄 처리.
                            // 이렇게 해야 2차, 3차 메뉴로 이동 시에도 메뉴가 유지됨.
                        }}
                    >
                        <Link to={item.path} onClick={item.name === '홈' ? scrollToTop : () => setActiveSubMenu(null)}>
                            {item.name}
                        </Link>
                        {item.subMenu && activeSubMenu === item.name && ( // ⭐ 2차 메뉴 렌더링 조건 ⭐
                            <div className="sub-menu">
                                {item.subMenu.map((subItem) => (
                                    <div
                                        key={subItem.name}
                                        className="sub-menu-item"
                                        onMouseEnter={() => setActiveSubMenu(item.name)} // 2차 메뉴에서도 부모 1차 메뉴 유지
                                    >
                                        <Link
                                            to={subItem.path}
                                            onClick={() => {
                                                setActiveSubMenu(null);
                                                setHovered(false);  // <-- 여기에 추가 (기존에는 없었음)
                                            }}
                                        >
                                            {subItem.name}
                                        </Link>
                                        {subItem.subSubMenu && ( // ⭐ 3차 메뉴 렌더링 조건 ⭐
                                            <div className="sub-sub-menu">
                                                {subItem.subSubMenu.map((subSubItem) => (
                                                    <Link
                                                        key={subSubItem.name}
                                                        to={subSubItem.path}
                                                        onClick={() => {
                                                            setActiveSubMenu(null);
                                                            setHovered(false);  // <-- 여기에도 추가
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
            </nav>
        </header>
    );
}

export default Header;