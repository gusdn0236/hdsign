import React from 'react';
import {Outlet} from 'react-router-dom'; // 하위 라우트 출력용
import Banner from '../../components/common/Banner';
import {galleryBannerImg} from '../../assets/img'; // 배너 이미지
import SubNav from "../../components/common/SubNav.jsx";

const GalleryLayout = () => {

    const galleryMenu = [
        {name: '갈바 간판류', path: '/Gallery/Galva'},
        {name: '스텐 간판류', path: '/Gallery/Stainless'},
        {name: '에폭시 간판류', path: '/Gallery/Epoxy'},
        {name: '특수/기타 가공물', path: '/Gallery/Special'},

    ];

    return (
        <div>
            <Banner image={galleryBannerImg} title="제품 사진"/>
            <SubNav links={galleryMenu}/>
            <div className="gallery-content">
                <Outlet/>
            </div>
        </div>
    );
};

export default GalleryLayout;