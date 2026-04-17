import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '아크릴', subCategory: '아크릴', description: '아크릴 소재를 이용한 특수 가공물입니다.' },
    { name: '포맥스', subCategory: '포맥스', description: '포맥스 소재를 이용한 가공물입니다.' },
    { name: '고무 스카시', subCategory: '고무 스카시', description: '고무 스카시 방식의 특수 가공물입니다.' },
    { name: '시트 커팅', subCategory: '시트 커팅', description: '시트 커팅 방식으로 제작된 가공물입니다.' },
];

const Special = () => <GalleryPage category="special" categoryTabs={categoryTabs} />;
export default Special;
