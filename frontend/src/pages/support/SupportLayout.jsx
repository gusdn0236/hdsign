import React from 'react';
import {Outlet} from 'react-router-dom'; // 하위 라우트 출력용
import Banner from '../../components/common/Banner';
import {supportBannerImg} from '../../assets/img'; // 배너 이미지
import SubNav from "../../components/common/SubNav.jsx";

const SupportLayout = () => {

    const supportMenu = [
        {name: '공지사항', path: '/Support/Notice'},
        {name: '견적/제작문의', path: '/Support/Contact'},


    ];

    return (
        <div>
            <Banner image={supportBannerImg} title="고객 지원"/>
            <SubNav links={supportMenu}/>
            <div className="support-content">
                <Outlet/>
            </div>
        </div>
    );
};

export default SupportLayout;