import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
const ScrollToTop = () => {
    const { pathname } = useLocation();
    const prevPathname = useRef(pathname);
    useEffect(() => {
        const prev = prevPathname.current;
        prevPathname.current = pathname;
        const getSection = (p) => p.split('/').filter(Boolean)[0]?.toLowerCase() || '';
        const isSameSection = getSection(prev) === getSection(pathname);
        if (!isSameSection) {
            window.scrollTo({ top: 0 });
        }
    }, [pathname]);
    return null;
};
export default ScrollToTop;