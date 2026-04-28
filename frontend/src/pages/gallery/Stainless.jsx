import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '스텐 전/후광', subCategory: '스텐 전/후광', description: '스테인리스 전광/후광 채널 간판입니다.' },
    { name: '스텐 오사이', subCategory: '스텐 오사이', description: '스테인리스 오사이 방식의 채널 간판입니다.' },
    { name: '스텐 측광', subCategory: '스텐 측광', description: '측광 방식의 스테인리스 채널 간판입니다.' },
    { name: '골드스텐', subCategory: '골드스텐', description: '골드 도금 처리된 스테인리스 채널 간판입니다.' },
];

const Stainless = () => <GalleryPage category="stainless" categoryTabs={categoryTabs} />;
export default Stainless;
