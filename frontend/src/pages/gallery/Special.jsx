import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '프레임간판', subCategory: '프레임간판', description: '다양한 프레임을 활용한 간판입니다.' },
    { name: '지주간판', subCategory: '지주간판', description: '지주를 세워 설치하는 간판입니다.' },
    { name: '아크릴/포맥스', subCategory: '아크릴/포맥스', description: '아크릴 또는 포맥스 소재로 제작된 가공물입니다.' },
    { name: '고무스카시', subCategory: '고무스카시', description: '고무 스카시 방식의 특수 가공물입니다.' },
];

const Special = () => <GalleryPage category="special" categoryTabs={categoryTabs} />;
export default Special;
