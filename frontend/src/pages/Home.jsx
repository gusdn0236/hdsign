// src/pages/Home.jsx

import HeroSection from "../components/home/HeroSection.jsx";
import './Home.css'
import TrustBannerSection from "../components/home/TrustBannerSection.jsx";
import QualityBannerSection from "../components/home/QualityBannerSection.jsx";
import ContactBannerSection from "../components/home/ContactBannerSection.jsx";


function Home() {

    return (
        <div className="home">
            <HeroSection></HeroSection>
            <TrustBannerSection></TrustBannerSection>
            <QualityBannerSection></QualityBannerSection>
            <ContactBannerSection></ContactBannerSection>
        </div>

    );
}

export default Home;