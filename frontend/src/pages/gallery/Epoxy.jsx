import React from 'react';
import GalleryPage from '../../components/gallery/GalleryPage';

import epoxyGalva01 from '../../assets/img/gallery/epoxy/galva/갈바에폭시_01.jpg';
import epoxyGalva02 from '../../assets/img/gallery/epoxy/galva/갈바에폭시_02.jpg';
import epoxySs01 from '../../assets/img/gallery/epoxy/stainless/스텐에폭시_01.jpg';
import epoxySs02 from '../../assets/img/gallery/epoxy/stainless/스텐에폭시_02.jpg';

const categories = [
    { name: '갈바 에폭시', description: '갈바 위에 에폭시 코팅 처리된 간판입니다.', images: [epoxyGalva01, epoxyGalva02] },
    { name: '스텐 에폭시', description: '스테인리스 위에 에폭시 코팅 처리된 간판입니다.', images: [epoxySs01, epoxySs02] },
];

const Epoxy = () => <GalleryPage categories={categories} />;
export default Epoxy;
