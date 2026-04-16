import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

const ScrollToTop = () => {
    const { pathname } = useLocation();
    const prevPathname = useRef(pathname);

    useEffect(() => {
        const prev = prevPathname.current;
        prevPathname.current = pathname;

        // 같은 섹션 내 이동이면 스크롤 유지
        const isSameSection = (a, b) => {
            const getSection = (p) => p.split('/')[1] || '';
            return getSection(a) === getSection(b);
        };

        if (!isSameSection(prev, pathname)) {
            window.scrollTo({ top: 0 });
        }
    }, [pathname]);

    return null;
};

export default ScrollToTop;
