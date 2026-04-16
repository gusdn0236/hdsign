import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import './GalleryPage.css';

const GalleryPage = ({ categories }) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = parseInt(searchParams.get('tab')) || 0;
    const [activeCategory, setActiveCategory] = useState(tabParam);
    const [selectedIndex, setSelectedIndex] = useState(null);

    useEffect(() => {
        const tab = parseInt(searchParams.get('tab')) || 0;
        setActiveCategory(tab);
        setSelectedIndex(null);
    }, [searchParams]);

    const currentImages = categories[activeCategory]?.images || [];
    const totalImages = currentImages.length;

    const openModal = (index) => setSelectedIndex(index);
    const closeModal = () => setSelectedIndex(null);
    const goPrev = () => selectedIndex > 0 && setSelectedIndex(selectedIndex - 1);
    const goNext = () => selectedIndex < totalImages - 1 && setSelectedIndex(selectedIndex + 1);

    const handleTabClick = (index) => {
        setSearchParams({ tab: index });
    };

    React.useEffect(() => {
        const handleKey = (e) => {
            if (selectedIndex === null) return;
            if (e.key === 'ArrowLeft') goPrev();
            if (e.key === 'ArrowRight') goNext();
            if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [selectedIndex]);

    return (
        <div className="gallery-page">
            <div className="gallery-tabs">
                {categories.map((cat, index) => (
                    <button
                        key={cat.name}
                        className={'gallery-tab' + (activeCategory === index ? ' active' : '')}
                        onClick={() => handleTabClick(index)}
                    >
                        {cat.name}
                    </button>
                ))}
            </div>
            {categories[activeCategory]?.description && (
                <p className="gallery-description">{categories[activeCategory].description}</p>
            )}
            {currentImages.length > 0 ? (
                <div className="gallery-grid">
                    {currentImages.map((src, index) => (
                        <div key={index} className="gallery-item" onClick={() => openModal(index)}>
                            <img src={src} alt={categories[activeCategory].name + '-' + (index + 1)} />
                            <div className="gallery-item-overlay">
                                <span className="gallery-item-icon">🔍</span>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="gallery-empty"><p>준비 중입니다.</p></div>
            )}
            {selectedIndex !== null && (
                <div className="gallery-modal" onClick={closeModal}>
                    <button className="modal-close" onClick={closeModal}>✕</button>
                    <button className="modal-nav modal-prev" onClick={(e) => { e.stopPropagation(); goPrev(); }} disabled={selectedIndex === 0}>‹</button>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <img src={currentImages[selectedIndex]} alt={'확대 이미지 ' + (selectedIndex + 1)} />
                        <p className="modal-counter">{selectedIndex + 1} / {totalImages}</p>
                    </div>
                    <button className="modal-nav modal-next" onClick={(e) => { e.stopPropagation(); goNext(); }} disabled={selectedIndex === totalImages - 1}>›</button>
                </div>
            )}
        </div>
    );
};

export default GalleryPage;
