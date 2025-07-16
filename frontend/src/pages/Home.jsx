// src/pages/Home.jsx

import HeroSection from "../components/home/HeroSection.jsx";
import './Home.css'
import TrustBannerSection from "../components/home/TrustBannerSection.jsx";
import QualitiyBannerSection from "../components/home/QualityBannerSection.jsx";


function Home() {

    return (
        <div className="home">
            <HeroSection></HeroSection>
            <TrustBannerSection></TrustBannerSection>
            <QualitiyBannerSection></QualitiyBannerSection>
        </div>

    );
}

export default Home;