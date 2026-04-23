import React from 'react';
import './Banner.css';

const Banner = ({ image, title, subtitle, action }) => {
    return (
        <div className="banner-container" style={{ backgroundImage: `url(${image})` }}>
            <div className="banner-overlay">
                <div className="banner-text-wrap">
                    <h1 className="banner-title">{title}</h1>
                    {subtitle && <p className="banner-subtitle">{subtitle}</p>}
                    {action && <div className="banner-action">{action}</div>}
                </div>
            </div>
        </div>
    );
};

export default Banner;
