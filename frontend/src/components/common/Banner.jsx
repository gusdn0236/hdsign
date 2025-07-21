import React from 'react';
import './Banner.css'; // 스타일 따로 관리 (아래 참고)

const Banner = ({image, title}) => {
    return (
        <div className="banner-container" style={{backgroundImage: `url(${image})`}}>
            <div className="banner-overlay">
                <h1 className="banner-title">{title}</h1>
            </div>
        </div>
    );
};

export default Banner;