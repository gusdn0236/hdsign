import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '스텐 캡', subCategory: '스텐 캡', description: '스테인리스 캡 방식의 간판입니다.' },
    { name: '스텐 오사이', subCategory: '스텐 오사이', description: '스테인리스 오사이 방식의 간판입니다.' },
    { name: '스텐 후광', subCategory: '스텐 후광', description: '야간 발광 시 고급스러운 느낌을 연출합니다.' },
    { name: '골드 스텐', subCategory: '골드 스텐', description: '골드 도금 처리된 스테인리스 간판입니다.' },
];

const Stainless = () => <GalleryPage category="stainless" categoryTabs={categoryTabs} />;
export default Stainless;
