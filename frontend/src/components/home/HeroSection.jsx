import React, {useRef, useState} from "react";
import './HeroSection.css'

const HeroSection = () => {

    const videoRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(true);

    const toggleVideo = () => {
        const video = videoRef.current;
        if (video) {
            if (video.paused) {
                video.play();
                setIsPlaying(true);
            } else {
                video.pause();
                setIsPlaying(false);
            }
        }
    }
    return (
        <div className="hero-section">
            <video
                ref={videoRef}
                className="background-video"
                autoPlay
                loop
                muted
                playsInline
            >
                <source src="video/homeSampleVideo.mp4" type="video/mp4"/>
            </video>

            <div className="overlay-text">
                <h1 className="title">
                    간판 제작의 새로운 기준,{' '}
                    <span className="highlight-h">H</span>
                    <span className="highlight-d">D</span>SIGN
                </h1>
                <p className="subtitle">20년 동안 변함없는 품질과 신뢰로 고객 만족을 실현합니다.</p>
            </div>

            <button className="video-toggle-btn" onClick={toggleVideo}>
                <img
                    src={isPlaying ? 'img/pause.png' : 'img/play.png'}
                    alt={isPlaying ? '일시정지' : '재생'}
                    className="video-toggle-icon"
                />
            </button>
        </div>
    )
}
export default HeroSection;