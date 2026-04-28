import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '타카채널', subCategory: '타카채널', description: '타카 방식으로 제작된 알루미늄 채널 간판입니다.' },
    { name: '일체형채널', subCategory: '일체형채널', description: '본체와 발광부가 하나로 제작된 알루미늄 일체형 채널 간판입니다.' },
];

const Aluminum = () => <GalleryPage category="aluminum" categoryTabs={categoryTabs} />;
export default Aluminum;
