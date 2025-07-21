// SubNav.jsx
import React from 'react';
import {NavLink} from 'react-router-dom';
import './SubNav.css';

const SubNav = ({links}) => {
    return (
        <nav className="sub-nav">
            <ul>
                {links.map((link, index) => (
                    <li key={index}>
                        <NavLink
                            to={link.path}
                            className={({isActive}) => isActive ? 'active' : ''}
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
