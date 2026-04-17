import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

const ScrollToTop = () => {
    const { pathname, search } = useLocation();
    const prevPathname = useRef(pathname);

    useEffect(() => {
        const prev = prevPathname.current;
        prevPathname.current = pathname;

        // 같은 1단계 경로 내 이동이면 스크롤 유지
        // 예: /about/greeting -> /about/certification 은 스크롤 유지
        // 예: /about/greeting -> /gallery/galva 는 맨 위로
        const getSection = (p) => p.split('/').filter(Boolean)[0] || '';
        const isSameSection = getSection(prev) === getSection(pathname);

        if (!isSameSection) {
            window.scrollTo({ top: 0 });
        }
    }, [pathname]);

    return null;
};

export default ScrollToTop;
