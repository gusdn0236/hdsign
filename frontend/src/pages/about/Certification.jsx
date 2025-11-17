import React, {useState} from 'react';

const Certification = () => {
    // 1. 상태 관리: 모달 표시 여부와 현재 선택된 이미지의 인덱스를 저장
    const [selectedImageIndex, setSelectedImageIndex] = useState(null);

    // 이미지 목록 (배열로 관리)
    const certImages = [
        "/images/certifications/cert1.jpg",
        "/images/certifications/cert2.jpg",
        "/images/certifications/cert3.jpg",
        "/images/certifications/cert4.jpg",
        "/images/certifications/cert5.jpg",
        "/images/certifications/cert6.jpg",
        "/images/certifications/cert7.jpg",
        "/images/certifications/cert8.jpg",
        "/images/certifications/cert9.jpg",
        "/images/certifications/cert10.jpg",
    ];

    const totalImages = certImages.length;

    // 2. 모달 제어 함수
    const openModal = (index) => {
        setSelectedImageIndex(index);
    };

    const closeModal = () => {
        setSelectedImageIndex(null);
    };

    // 3. 모달 내 이동 함수
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
                    textAlign: 'center' // ⬅️ 중앙 정렬 추가
                }}
            >
                인증서 및 표창장
            </h2>

            {/* 그리드 영역: 한 줄에 3개씩 배치 (사이즈 키움) */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)', // 3열 고정
                // gap: '20px', ⬅️ 기존 간격 제거
                columnGap: '15px',     // ⬅️ 좌우 간격 (줄임)
                gridRowGap: '40px',    // ⬅️ 세로 간격 (늘림)
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

            {/* 모달 (확대 이미지) 영역 */}
            {currentImageSrc && (
                <div
                    onClick={closeModal}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: '100vw',
                        height: '100vh',
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        zIndex: 2000,
                        cursor: 'zoom-out'
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
                        {/* 좌우 이동 버튼 */}
                        <button
                            onClick={goToPrev}
                            disabled={isPrevDisabled}
                            style={modalButtonStyle('left', isPrevDisabled)}
                        >
                            &lt;
                        </button>

                        <img
                            src={currentImageSrc}
                            alt="Enlarged certification"
                            style={{
                                maxWidth: '85vw',
                                maxHeight: '85vh',
                                borderRadius: '8px',
                                boxShadow: '0 4px 20px rgba(0,0,0,0.8)',
                                cursor: 'default'
                            }}
                        />

                        <button
                            onClick={goToNext}
                            disabled={isNextDisabled}
                            style={modalButtonStyle('right', isNextDisabled)}
                        >
                            &gt;
                        </button>
                    </div>

                    {/* 닫기 버튼 */}
                    <button
                        onClick={closeModal}
                        style={{
                            position: 'absolute',
                            top: '20px',
                            right: '30px',
                            background: 'none',
                            border: 'none',
                            color: 'white',
                            fontSize: '40px',
                            fontWeight: '300',
                            cursor: 'pointer',
                            zIndex: 2001
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