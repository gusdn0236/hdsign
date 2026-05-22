import React from 'react';
import { Outlet, Link } from 'react-router-dom';
import Banner from '../../components/common/Banner';
import SubNav from '../../components/common/SubNav.jsx';
import { supportBannerImg } from '../../assets/img';
import { useAuth } from '../../context/AuthContext';
import AdminFolderChangeNotice from './AdminFolderChangeNotice.jsx';
import DemoBanner from '../../components/common/DemoBanner.jsx';
import { isDemoToken } from '../../utils/demoGuard';
import './AdminLayout.css';

const AdminLayout = () => {
    const { logout, token } = useAuth();
    const isDemo = isDemoToken(token);

    const adminMenu = [
        { name: '발주 관리', path: '/admin/orders' },
        { name: '작업 현황', path: '/admin/work-status' },
        { name: '견적 관리', path: '/admin/quotes' },
        // 견적 프로그램(개발 중) — 메뉴에서 숨김. 라우트는 살아 있어 직접 URL 로만 접근:
        //   단가 마스터 /admin/rates · 작업 사례 /admin/cases
        { name: '대리 발주', path: '/admin/proxy-order' },
        { name: '거래처 관리', path: '/admin/clients' },
        { name: '단가계산기', path: '/admin/prices' },
        { name: '이미지 관리', path: '/admin/gallery-upload' },
        { name: '공지사항 관리', path: '/admin/notices' },
        { name: '현장작업완료사진', path: '/admin/evidence' },
    ];

    return (
        <div>
            {isDemo && <DemoBanner />}
            <Banner
                image={supportBannerImg}
                title="관리자 포털"
                subtitle="HD Sign 관리자 페이지"
                action={(
                    <div className="admin-banner-actions">
                        <Link to="/" className="admin-banner-home-link">홈페이지</Link>
                        <button type="button" className="admin-banner-logout-btn" onClick={logout}>
                            로그아웃
                        </button>
                    </div>
                )}
            />
            <SubNav links={adminMenu} />
            <AdminFolderChangeNotice />
            <div className="admin-content">
                <Outlet />
            </div>
        </div>
    );
};

export default AdminLayout;
