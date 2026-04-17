import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

const categoryTabs = [
    { name: '갈바 에폭시', subCategory: '갈바 에폭시', description: '갈바 위에 에폭시 코팅 처리된 간판입니다.' },
    { name: '스텐 에폭시', subCategory: '스텐 에폭시', description: '스테인리스 위에 에폭시 코팅 처리된 간판입니다.' },
];

const Epoxy = () => <GalleryPage category="epoxy" categoryTabs={categoryTabs} />;
export default Epoxy;
