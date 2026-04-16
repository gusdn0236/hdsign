import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

import acrylic01 from '../../assets/img/gallery/special/acrylic/아크릴_01.jpg';
import acrylic02 from '../../assets/img/gallery/special/acrylic/아크릴_02.jpg';
import foamex01 from '../../assets/img/gallery/special/foamex/포맥스_01.jpg';
import foamex02 from '../../assets/img/gallery/special/foamex/포맥스_02.jpg';
import rubber01 from '../../assets/img/gallery/special/rubber/고무스카시_01.jpg';
import rubber02 from '../../assets/img/gallery/special/rubber/고무스카시_02.jpg';
import sheet01 from '../../assets/img/gallery/special/sheetcutting/시트커팅_01.jpg';
import sheet02 from '../../assets/img/gallery/special/sheetcutting/시트커팅_02.jpg';

const categories = [
    { name: '아크릴',    description: '아크릴 소재를 이용한 특수 가공물입니다.',       images: [acrylic01, acrylic02] },
    { name: '포맥스',    description: '포맥스 소재를 이용한 가공물입니다.',             images: [foamex01, foamex02] },
    { name: '고무 스카시', description: '고무 스카시 방식의 특수 가공물입니다.',        images: [rubber01, rubber02] },
    { name: '시트 커팅', description: '시트 커팅 방식으로 제작된 가공물입니다.',        images: [sheet01, sheet02] },
];

const Special = () => <GalleryPage categories={categories} />;
export default Special;
