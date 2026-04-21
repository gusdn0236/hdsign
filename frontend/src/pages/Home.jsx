// src/pages/Home.jsx
import { useEffect } from 'react';
import HeroSection from "../components/home/HeroSection.jsx";
import './Home.css'
import TrustBannerSection from "../components/home/TrustBannerSection.jsx";
import QualityBannerSection from "../components/home/QualityBannerSection.jsx";
import ContactBannerSection from "../components/home/ContactBannerSection.jsx";
import Lenis from 'lenis';

function Home() {
    useEffect(() => {
        const lenis = new Lenis({
            duration: 1.5,
            easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        });

        function raf(time) {
            lenis.raf(time);
            requestAnimationFrame(raf);
        }
        const rafId = requestAnimationFrame(raf);

        return () => {
            lenis.destroy();
            cancelAnimationFrame(rafId);
        };
    }, []);

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