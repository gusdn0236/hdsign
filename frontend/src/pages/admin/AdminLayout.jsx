import React, { useState } from 'react';
import AdminPasswordModal from './AdminPasswordModal.jsx';
import { Outlet, Link } from 'react-router-dom';
import Banner from '../../components/common/Banner';
import SubNav from '../../components/common/SubNav.jsx';
import { supportBannerImg } from '../../assets/img';
import { useAuth } from '../../context/AuthContext';
import AdminFolderChangeNotice from './AdminFolderChangeNotice.jsx';
import DemoBanner from '../../components/common/DemoBanner.jsx';
import DemoButtonLock from '../../components/common/DemoButtonLock.jsx';
import { isDemoToken } from '../../utils/demoGuard';
import ScrapDrawer from './scrap/ScrapDrawer.tsx';
import EasyformAutoSync from './autoquote/EasyformAutoSync.tsx';
import './AdminLayout.css';

const AdminLayout = () => {
    const { logout, token } = useAuth();
    const isDemo = isDemoToken(token);
    const [pwOpen, setPwOpen] = useState(false);

    const adminMenu = [
        { name: '발주 관리', path: '/admin/orders' },
        { name: '작업 현황', path: '/admin/work-status' },
        // 잘 안 써서 메뉴에서 숨김(2026-11-18). 라우트는 살아 있어 직접 URL 로만 접근:
        //   견적 관리 /admin/quotes · 대리 발주 /admin/proxy-order
        // 견적 프로그램(개발 중) — 메뉴에서 숨김. 라우트는 살아 있어 직접 URL 로만 접근:
        //   단가 마스터 /admin/rates · 작업 사례 /admin/cases
        { name: '거래처 관리', path: '/admin/clients' },
        { name: '단가계산기', path: '/admin/prices' },
        { name: '이미지 관리', path: '/admin/gallery-upload' },
        { name: '공지사항 관리', path: '/admin/notices' },
        { name: '현장작업완료사진', path: '/admin/evidence' },
        { name: '매출분석', path: '/admin/analytics' },
    ];

    return (
        <div className="admin-shell">
            {/* 왼쪽 스크랩 서랍 — 관리자 화면 어디서든 떠 있음(이 PC 에만 저장) */}
            <ScrapDrawer token={token} />
            {/* 이지폼 '매출 거래명세서' [저장] → 이 PC 워처가 묻고 → 홈페이지 반영 확인 카드(관리자 화면 어디서든) */}
            <EasyformAutoSync token={token} />
            {isDemo && <DemoBanner />}
            {isDemo && <DemoButtonLock />}
            <Banner
                image={supportBannerImg}
                title="관리자 포털"
                subtitle="HD Sign 관리자 페이지"
                action={(
                    <div className="admin-banner-actions">
                        <Link to="/" className="admin-banner-home-link">홈페이지</Link>
                        {!isDemo && (
                            <button type="button" className="admin-banner-pw-btn" onClick={() => setPwOpen(true)}>
                                비밀번호 변경
                            </button>
                        )}
                        <button type="button" className="admin-banner-logout-btn" onClick={logout}>
                            로그아웃
                        </button>
                    </div>
                )}
            />
            {pwOpen && <AdminPasswordModal token={token} onClose={() => setPwOpen(false)} />}
            <SubNav links={adminMenu} />
            <AdminFolderChangeNotice />
            <div className="admin-content">
                <Outlet />
            </div>
        </div>
    );
};

export default AdminLayout;
