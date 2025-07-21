import React from 'react';
import {Outlet} from 'react-router-dom'; // 하위 라우트 출력용
import Banner from '../../components/common/Banner';
import {aboutBannerImg} from '../../assets/img'; // 배너 이미지
import SubNav from "../../components/common/SubNav.jsx";

const AboutLayout = () => {

    const aboutMenu = [
        {name: '인사말', path: '/About/Greeting'},
        {name: '인증서', path: '/About/Certification'},
        {name: '부서 소개', path: '/About/Departments'},
        {name: '보유 장비', path: '/About/Equipment'},
        {name: '오시는 길', path: '/About/Directions'}
    ];

    return (
        <div>
            <Banner image={aboutBannerImg} title="회사 소개"/>
            <SubNav links={aboutMenu}/>
            <div className="about-content">
                <Outlet/>
            </div>
        </div>
    );
};

export default AboutLayout;