import React from 'react';
import { Outlet, Navigate, Link } from 'react-router-dom';
import Banner from '../../components/common/Banner';
import SubNav from '../../components/common/SubNav.jsx';
import { supportBannerImg } from '../../assets/img';
import { useAuth } from '../../context/AuthContext';
import './ClientLayout.css';

const ClientLayout = () => {
    const { clientUser, clientToken, clientLoading } = useAuth();
    if (clientLoading) return null;
    if (!clientUser || !clientToken) return <Navigate to="/client/login" replace />;

    const companyName = typeof clientUser === 'object' ? clientUser.companyName?.trim() : '';
    const contactName = typeof clientUser === 'object' ? clientUser.contactName?.trim() : '';
    const welcomeMessage = companyName
        ? `${companyName}님, 환영합니다`
        : contactName
            ? `${contactName}님, 환영합니다`
            : 'HD Sign 거래처 포털 방문을 환영합니다';

    const clientMenu = [
        { name: '작업 요청', path: '/client/request' },
        { name: '작업 현황', path: '/client/status' },
    ];

    return (
        <div>
            <Banner
                image={supportBannerImg}
                title="거래처 포털"
                subtitle={welcomeMessage}
                action={(
                    <Link to="/" className="client-banner-home-link">
                        홈페이지로 돌아가기
                    </Link>
                )}
            />
            <SubNav links={clientMenu} />
            <div className="client-content">
                <Outlet />
            </div>
        </div>
    );
};

export default ClientLayout;
