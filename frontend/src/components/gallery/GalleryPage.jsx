import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import './GalleryPage.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const GalleryPage = ({ category, categoryTabs }) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = parseInt(searchParams.get('tab')) || 0;
    const [activeTab, setActiveTab] = useState(tabParam);
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(null);
    const scrollRef = useRef(null);

    useEffect(() => {
        const tab = parseInt(searchParams.get('tab')) || 0;
        setActiveTab(tab);
        setSelectedIndex(null);
    }, [searchParams]);

    useEffect(() => {
        setLoading(true);
        fetch(BASE_URL + '/api/gallery?category=' + category)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                setImages(data);
                setLoading(false);
            })
            .catch(function() { setLoading(false); });
    }, [category]);

    const currentSubCategory = categoryTabs[activeTab] ? categoryTabs[activeTab].subCategory : null;
    const currentImages = currentSubCategory
        ? images.filter(function(img) { return img.subCategory === currentSubCategory; })
        : images;

    const totalImages = currentImages.length;
    const openModal = function(index) { setSelectedIndex(index); };
    const closeModal = function() { setSelectedIndex(null); };
    const goPrev = function() { if (selectedIndex > 0) setSelectedIndex(selectedIndex - 1); };
    const goNext = function() { if (selectedIndex < totalImages - 1) setSelectedIndex(selectedIndex + 1); };

    const handleTabClick = function(index) {
        const scrollY = window.scrollY;
        setSearchParams({ tab: index }, { preventScrollReset: true });
        requestAnimationFrame(function() {
            window.scrollTo({ top: scrollY, behavior: 'instant' });
        });
    };

    React.useEffect(function() {
        const handleKey = function(e) {
            if (selectedIndex === null) return;
            if (e.key === 'ArrowLeft') goPrev();
            if (e.key === 'ArrowRight') goNext();
            if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', handleKey);
        return function() { window.removeEventListener('keydown', handleKey); };
    }, [selectedIndex]);

    return (
        React.createElement('div', { className: 'gallery-page', ref: scrollRef },
            React.createElement('div', { className: 'gallery-tabs' },
                categoryTabs.map(function(cat, index) {
                    return React.createElement('button', {
                        key: cat.name,
                        className: 'gallery-tab' + (activeTab === index ? ' active' : ''),
                        onClick: function() { handleTabClick(index); }
                    }, cat.name);
                })
            ),
            categoryTabs[activeTab] && categoryTabs[activeTab].description
                ? React.createElement('p', { className: 'gallery-description' }, categoryTabs[activeTab].description)
                : null,
            loading
                ? React.createElement('div', { className: 'gallery-empty' }, React.createElement('p', null, '\uBD88\uB7EC\uC624\uB294 \uC911...'))
                : currentImages.length > 0
                    ? React.createElement('div', { className: 'gallery-grid' },
                        currentImages.map(function(img, index) {
                            return React.createElement('div', {
                                key: img.id,
                                className: 'gallery-item',
                                onClick: function() { openModal(index); }
                            },
                                React.createElement('img', { src: img.imageUrl, alt: img.originalName }),
                                React.createElement('div', { className: 'gallery-item-overlay' },
                                    React.createElement('span', { className: 'gallery-item-icon' }, '\uD83D\uDD0D')
                                )
                            );
                        })
                    )
                    : React.createElement('div', { className: 'gallery-empty' }, React.createElement('p', null, '\uC900\uBE44 \uC911\uC785\uB2C8\uB2E4.')),
            selectedIndex !== null
                ? React.createElement('div', { className: 'gallery-modal', onClick: closeModal },
                    React.createElement('button', { className: 'modal-close', onClick: closeModal }, '\u2715'),
                    React.createElement('button', {
                        className: 'modal-nav modal-prev',
                        onClick: function(e) { e.stopPropagation(); goPrev(); },
                        disabled: selectedIndex === 0
                    }, '\u2039'),
                    React.createElement('div', { className: 'modal-content', onClick: function(e) { e.stopPropagation(); } },
                        React.createElement('img', { src: currentImages[selectedIndex] ? currentImages[selectedIndex].imageUrl : '', alt: '\uD655\uB300 \uC774\uBBF8\uC9C0 ' + (selectedIndex + 1) }),
                        React.createElement('p', { className: 'modal-counter' }, (selectedIndex + 1) + ' / ' + totalImages)
                    ),
                    React.createElement('button', {
                        className: 'modal-nav modal-next',
                        onClick: function(e) { e.stopPropagation(); goNext(); },
                        disabled: selectedIndex === totalImages - 1
                    }, '\u203A')
                )
                : null
        )
    );
};

export default GalleryPage;