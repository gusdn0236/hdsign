import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

import ssCap01 from '../../assets/img/gallery/stainless/cap/스텐캡_01.jpg';
import ssCap02 from '../../assets/img/gallery/stainless/cap/스텐캡_02.jpg';
import ssOsai01 from '../../assets/img/gallery/stainless/osai/스텐오사이_01.jpg';
import ssOsai02 from '../../assets/img/gallery/stainless/osai/스텐오사이_02.jpg';
import ssHalo01 from '../../assets/img/gallery/stainless/halo/스텐후광_01.jpg';
import ssHalo02 from '../../assets/img/gallery/stainless/halo/스텐후광_02.jpg';
import ssGold01 from '../../assets/img/gallery/stainless/gold/골드스텐_01.jpg';
import ssGold02 from '../../assets/img/gallery/stainless/gold/골드스텐_02.jpg';

const categories = [
    { name: '스텐 캡',  description: '스테인리스 캡 방식의 간판입니다.',           images: [ssCap01, ssCap02] },
    { name: '스텐 오사이', description: '스테인리스 오사이 방식의 간판입니다.',     images: [ssOsai01, ssOsai02] },
    { name: '스텐 후광', description: '야간 발광 시 고급스러운 느낌을 연출합니다.', images: [ssHalo01, ssHalo02] },
    { name: '골드 스텐', description: '골드 도금 처리된 스테인리스 간판입니다.',    images: [ssGold01, ssGold02] },
];

const Stainless = () => <GalleryPage categories={categories} />;
export default Stainless;
