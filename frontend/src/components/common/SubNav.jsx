// SubNav.jsx
import React from 'react';
import {NavLink} from 'react-router-dom';
import './SubNav.css';

const SubNav = ({links}) => {

    const scrollToTop = () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth' // 부드러운 스크롤 효과
        });
    };


    return (
        <nav className="sub-nav">
            <ul>
                {links.map((link, index) => (
                    <li key={index}>
                        <NavLink
                            to={link.path}
                            className={({isActive}) => isActive ? 'active' : ''}
                            onClick={scrollToTop}
                        >
                            {link.name}
                        </NavLink>
                    </li>
                ))}
            </ul>
        </nav>
    );
};

export default SubNav;
