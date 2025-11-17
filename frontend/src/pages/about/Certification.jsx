import React, {useState} from 'react';
// =======================================================
// 1. 이미지를 직접 Import하여 변수로 사용합니다.
// (경로가 src/assets/img/certifications 라고 가정했을 때의 예시)
// =======================================================
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


const Certification = () => {
    // 1. 상태 관리: 모달 표시 여부와 현재 선택된 이미지의 인덱스를 저장
    const [selectedImageIndex, setSelectedImageIndex] = useState(null);

    // 이미지 목록 (Import된 변수로 변경)
    const certImages = [
        cert1,
        cert2,
        cert3,
        cert4,
        cert5,
        cert6,
        cert7,
        cert8,
        cert9,
        cert10,
    ];

    const totalImages = certImages.length;
    // ... (이하 모든 로직은 동일합니다)
    // ...
    const openModal = (index) => {
        setSelectedImageIndex(index);
    };

    const closeModal = () => {
        setSelectedImageIndex(null);
    };

    const goToPrev = () => {
        if (selectedImageIndex > 0) {
            setSelectedImageIndex(selectedImageIndex - 1);
        }
    };

    const goToNext = () => {
        if (selectedImageIndex < totalImages - 1) {
            setSelectedImageIndex(selectedImageIndex + 1);
        }
    };

    const currentImageSrc = selectedImageIndex !== null ? certImages[selectedImageIndex] : null;

    const isPrevDisabled = selectedImageIndex === 0;
    const isNextDisabled = selectedImageIndex === totalImages - 1;

    return (
        <div style={{padding: '20px'}}>
            <h2
                style={{
                    marginTop: '50px',
                    marginBottom: '100px',
                    textAlign: 'center'
                }}
            >
                인증서 및 표창장
            </h2>

            {/* 그리드 영역: 한 줄에 3개씩 배치 (사이즈 키움) */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                columnGap: '15px',
                gridRowGap: '40px',
                maxWidth: '1000px',
                margin: '0 auto'
            }}>
                {certImages.map((src, index) => (
                    <div
                        key={index}
                        onClick={() => openModal(index)}
                        style={{
                            cursor: 'pointer',
                            overflow: 'hidden',
                            borderRadius: '8px',
                            boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
                            transition: 'transform 0.2s',
                            aspectRatio: '16 / 10'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.03)'}
                        onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    >
                        {/* src에 import된 변수(이미지 경로)가 사용됩니다 */}
                        <img
                            src={src}
                            alt={`cert-${index + 1}`}
                            style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                display: 'block'
                            }}
                        />
                    </div>
                ))}
            </div>

            {/* 모달 (확대 이미지) 영역 - 하단 생략 */}
            {currentImageSrc && (
                <div
                    onClick={closeModal}
                    style={{
                        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
                        backgroundColor: 'rgba(0, 0, 0, 0.9)', display: 'flex', justifyContent: 'center',
                        alignItems: 'center', zIndex: 2000, cursor: 'zoom-out'
                    }}
                >
                    <div
                        style={{
                            position: 'relative',
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            width: 'auto',
                            height: 'auto'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button onClick={goToPrev} disabled={isPrevDisabled}
                                style={modalButtonStyle('left', isPrevDisabled)}> &lt; </button>
                        <img
                            src={currentImageSrc}
                            alt="Enlarged certification"
                            style={{
                                maxWidth: '85vw', maxHeight: '85vh', borderRadius: '8px',
                                boxShadow: '0 4px 20px rgba(0,0,0,0.8)', cursor: 'default'
                            }}
                        />
                        <button onClick={goToNext} disabled={isNextDisabled}
                                style={modalButtonStyle('right', isNextDisabled)}> &gt; </button>
                    </div>

                    <button
                        onClick={closeModal}
                        style={{
                            position: 'absolute', top: '20px', right: '30px', background: 'none', border: 'none',
                            color: 'white', fontSize: '40px', fontWeight: '300', cursor: 'pointer', zIndex: 2001
                        }}
                    >
                        &times;
                    </button>
                </div>
            )}
        </div>
    );
};

export default Certification;

// 버튼 스타일을 위한 헬퍼 함수
const modalButtonStyle = (direction, disabled) => ({
    position: 'absolute',
    top: '50%',
    [direction]: '-60px',
    transform: 'translateY(-50%)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: 'white',
    border: '1px solid rgba(255, 255, 255, 0.5)',
    borderRadius: '50%',
    width: '50px',
    height: '50px',
    fontSize: '24px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 0.8,
    transition: 'opacity 0.3s, background 0.3s',
    outline: 'none',
    zIndex: 2001
});