// src/pages/Home.jsx

import HeroSection from "../components/home/HeroSection.jsx";
import './Home.css'
import TrustBannerSection from "../components/home/TrustBannerSection.jsx";
import QualityBannerSection from "../components/home/QualityBannerSection.jsx";


function Home() {

    return (
        <div className="home">
            <HeroSection></HeroSection>
            <TrustBannerSection></TrustBannerSection>
            <QualityBannerSection></QualityBannerSection>
        </div>

    );
}

export default Home;