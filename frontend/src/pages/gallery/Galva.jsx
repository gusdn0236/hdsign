import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '갈바 후광', subCategory: '갈바 후광', description: '갈바나이징 처리된 후광 간판입니다. 야간 발광 효과가 뛰어납니다.' },
    { name: '갈바 오사이', subCategory: '갈바 오사이', description: '오사이 방식의 갈바 간판입니다. 깔끔하고 고급스러운 마감이 특징입니다.' },
    { name: '갈바 캡', subCategory: '갈바 캡', description: '갈바 캡 방식의 간판으로 내구성이 뛰어납니다.' },
    { name: '일체형', subCategory: '일체형', description: '본체와 발광부가 하나로 제작된 일체형 간판입니다.' },
];

const Galva = () => <GalleryPage category="galva" categoryTabs={categoryTabs} />;
export default Galva;
