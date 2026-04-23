import React from 'react';
import { Outlet, Link } from 'react-router-dom';
import Banner from '../../components/common/Banner';
import SubNav from '../../components/common/SubNav.jsx';
import { supportBannerImg } from '../../assets/img';
import { useAuth } from '../../context/AuthContext';
import './AdminLayout.css';

const AdminLayout = () => {
    const { logout } = useAuth();

    const adminMenu = [
        { name: '작업 관리', path: '/admin/orders' },
        { name: '거래처 관리', path: '/admin/clients' },
        { name: '이미지 관리', path: '/admin/gallery-upload' },
        { name: '공지사항 관리', path: '/admin/notices' },
    ];

    return (
        <div>
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
            <div className="admin-content">
                <Outlet />
            </div>
        </div>
    );
};

export default AdminLayout;
