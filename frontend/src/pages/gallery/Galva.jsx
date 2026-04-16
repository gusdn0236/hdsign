import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

import galvaHalo01 from '../../assets/img/gallery/galva/halo/갈바후광_01.jpg';
import galvaHalo02 from '../../assets/img/gallery/galva/halo/갈바후광_02.jpg';
import galvaHalo03 from '../../assets/img/gallery/galva/halo/갈바후광_03.jpg';
import galvaOsai01 from '../../assets/img/gallery/galva/osai/갈바오사이_01.jpg';
import galvaOsai02 from '../../assets/img/gallery/galva/osai/갈바오사이_02.jpg';
import galvaOsai03 from '../../assets/img/gallery/galva/osai/갈바오사이_03.jpg';
import galvaCap01 from '../../assets/img/gallery/galva/cap/갈바캡_01.jpg';
import galvaCap02 from '../../assets/img/gallery/galva/cap/갈바캡_02.jpg';
import galvaCap03 from '../../assets/img/gallery/galva/cap/갈바캡_03.jpg';
import galvaInt01 from '../../assets/img/gallery/galva/integrated/일체형_01.jpg';
import galvaInt02 from '../../assets/img/gallery/galva/integrated/일체형_02.jpg';
import galvaInt03 from '../../assets/img/gallery/galva/integrated/일체형_03.jpg';

const categories = [
    {
        name: '갈바 후광',
        description: '갈바나이징 처리된 후광 간판입니다. 야간 발광 효과가 뛰어납니다.',
        images: [galvaHalo01, galvaHalo02, galvaHalo03],
    },
    {
        name: '갈바 오사이',
        description: '오사이 방식의 갈바 간판입니다. 깔끔하고 고급스러운 마감이 특징입니다.',
        images: [galvaOsai01, galvaOsai02, galvaOsai03],
    },
    {
        name: '갈바 캡',
        description: '갈바 캡 방식의 간판으로 내구성이 뛰어납니다.',
        images: [galvaCap01, galvaCap02, galvaCap03],
    },
    {
        name: '일체형',
        description: '본체와 발광부가 하나로 제작된 일체형 간판입니다.',
        images: [galvaInt01, galvaInt02, galvaInt03],
    },
];

const Galva = () => <GalleryPage categories={categories} />;
export default Galva;
