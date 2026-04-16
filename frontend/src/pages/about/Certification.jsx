import React, { useState } from 'react';
import './Certification.css';

import cert1 from '../../assets/img/certifications/cert1.jpg';
import cert2 from '../../assets/img/certifications/cert2.jpg';
import cert3 from '../../assets/img/certifications/cert3.jpg';
import cert4 from '../../assets/img/certifications/cert4.jpg';
import cert5 from '../../assets/img/certifications/cert5.jpg';
import cert6 from '../../assets/img/certifications/cert6.jpg';
import cert7 from '../../assets/img/certifications/cert7.jpg';
import cert8 from '../../assets/img/certifications/cert8.jpg';
import cert9 from '../../assets/img/certifications/cert9.jpg';
import cert10 from '../../assets/img/certifications/cert10.jpg';

const certImages = [cert1, cert2, cert3, cert4, cert5, cert6, cert7, cert8, cert9, cert10];

const Certification = () => {
    const [selectedIndex, setSelectedIndex] = useState(null);
    const totalImages = certImages.length;

    const openModal = (index) => setSelectedIndex(index);
    const closeModal = () => setSelectedIndex(null);
    const goPrev = () => selectedIndex > 0 && setSelectedIndex(selectedIndex - 1);
    const goNext = () => selectedIndex < totalImages - 1 && setSelectedIndex(selectedIndex + 1);

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
        <div className="cert-page">
            <h2 className="cert-title">인증서 및 표창장</h2>
            <p className="cert-subtitle">에이치디사인이 걸어온 신뢰의 증거입니다.</p>

            <div className="cert-grid">
                {certImages.map((src, index) => (
                    <div
                        key={index}
                        className="cert-item"
                        onClick={() => openModal(index)}
                    >
                        <img src={src} alt={'인증서 ' + (index + 1)} />
                        <div className="cert-item-overlay">
                            <span className="cert-item-icon">🔍</span>
                        </div>
                    </div>
                ))}
            </div>

            {selectedIndex !== null && (
                <div className="cert-modal" onClick={closeModal}>
                    <button className="cert-modal-close" onClick={closeModal}>✕</button>
                    <button
                        className="cert-modal-nav cert-modal-prev"
                        onClick={(e) => { e.stopPropagation(); goPrev(); }}
                        disabled={selectedIndex === 0}
                    >‹</button>
                    <div className="cert-modal-content" onClick={(e) => e.stopPropagation()}>
                        <img src={certImages[selectedIndex]} alt={'인증서 확대 ' + (selectedIndex + 1)} />
                        <p className="cert-modal-counter">{selectedIndex + 1} / {totalImages}</p>
                    </div>
                    <button
                        className="cert-modal-nav cert-modal-next"
                        onClick={(e) => { e.stopPropagation(); goNext(); }}
                        disabled={selectedIndex === totalImages - 1}
                    >›</button>
                </div>
            )}
        </div>
    );
};

export default Certification;
