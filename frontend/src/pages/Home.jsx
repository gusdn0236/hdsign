// src/pages/Home.jsx

import HeroSection from "../components/home/HeroSection.jsx";
import './Home.css'
import TrustBannerSection from "../components/home/TrustBannerSection.jsx";


function Home() {

    return (
        <div className="home">
            <HeroSection></HeroSection>
            <TrustBannerSection></TrustBannerSection>
        </div>

    );
}

export default Home;