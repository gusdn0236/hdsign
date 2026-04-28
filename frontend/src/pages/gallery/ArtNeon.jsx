import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '아크릴네온', subCategory: '아크릴네온', description: '아크릴 소재로 제작된 네온 사인입니다.' },
    { name: '아크릴조각사인', subCategory: '아크릴조각사인', description: '아크릴 조각으로 제작된 사인입니다.' },
];

const ArtNeon = () => <GalleryPage category="artneon" categoryTabs={categoryTabs} />;
export default ArtNeon;
