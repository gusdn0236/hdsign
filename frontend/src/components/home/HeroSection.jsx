import React, { useRef, useState, useEffect } from "react";
import './HeroSection.css'
import { useGsapFadeUp } from "../../hooks/useGsapFadeUp.js";
import { homeVideo } from "../../assets/video/index.js";
import { pauseIcon, playIcon } from "../../assets/img/index.js"

const HeroSection = React.memo(() => {
    const videoRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const userPaused = useRef(false);

    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                if (!userPaused.current) {
                    videoRef.current?.play().then(() => setIsPlaying(true)).catch(() => {});
                }
            } else {
                videoRef.current?.pause();
                if (!userPaused.current) setIsPlaying(false);
            }
        }, { threshold: 0.3 });

        if (videoRef.current) observer.observe(videoRef.current);
        return () => observer.disconnect();
    }, []);

    const toggleVideo = () => {
        const video = videoRef.current;
        if (video) {
            if (video.paused) {
                video.play();
                setIsPlaying(true);
                userPaused.current = false;
            } else {
                video.pause();
                setIsPlaying(false);
                userPaused.current = true;
            }
        }
    };

    const titleRef = useRef(null);
    const subtitleRef = useRef(null);
    const buttonRef = useRef(null);

    useGsapFadeUp([titleRef, subtitleRef, buttonRef]);

    return (
        <div className="hero-section">
            <video
                ref={videoRef}
                className="background-video"
                loop
                muted
                playsInline
                preload="none"
            >
                <source src={homeVideo} type="video/mp4"/>
            </video>
            <div className="video-overlay-gradient" />

            <div className="overlay-text">
                <h1 className="title" ref={titleRef}>
                    간판 제작의 새로운 기준, HDSIGN
                </h1>
                <p className="subtitle" ref={subtitleRef}>20년 동안 변함없는 품질과 신뢰로 고객 만족을 실현합니다.</p>
            </div>

            <button className="video-toggle-btn" onClick={toggleVideo} ref={buttonRef}>
                <img
                    src={isPlaying ? pauseIcon : playIcon}
                    alt={isPlaying ? '일시정지' : '재생'}
                    className="video-toggle-icon"
                />
            </button>
        </div>
    )
});
export default HeroSection;