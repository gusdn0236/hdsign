import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '갈바 전/후광', subCategory: '갈바 전/후광', description: '갈바나이징 처리된 전광/후광 채널 간판입니다.' },
    { name: '갈바 오사이', subCategory: '갈바 오사이', description: '오사이 방식의 갈바 채널 간판입니다.' },
    { name: '갈바 측광', subCategory: '갈바 측광', description: '측광 방식의 갈바 채널 간판입니다.' },
];

const Galva = () => <GalleryPage category="galva" categoryTabs={categoryTabs} />;
export default Galva;
