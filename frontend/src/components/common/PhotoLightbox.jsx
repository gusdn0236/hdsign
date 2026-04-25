import { useEffect } from 'react';
import './PhotoLightbox.css';

/**
 * 사진 확대 보기 오버레이.
 * photos: [{ src, alt, dept, time }]
 * index: 현재 보고 있는 인덱스 (null/undefined면 닫힘)
 * onClose: () => void
 * onIndexChange: (nextIndex) => void
 */
export default function PhotoLightbox({ photos, index, onClose, onIndexChange }) {
    const open = index != null && photos && photos[index];

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') onClose?.();
            else if (e.key === 'ArrowLeft' && index > 0) onIndexChange?.(index - 1);
            else if (e.key === 'ArrowRight' && index < photos.length - 1) onIndexChange?.(index + 1);
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, index, photos, onClose, onIndexChange]);

    if (!open) return null;

    const photo = photos[index];
    const total = photos.length;

    return (
        <div className="photo-lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true">
            <button
                type="button"
                className="photo-lightbox-close"
                onClick={(e) => {
                    e.stopPropagation();
                    onClose?.();
                }}
                aria-label="닫기"
            >
                ×
            </button>

            {index > 0 && (
                <button
                    type="button"
                    className="photo-lightbox-nav prev"
                    onClick={(e) => {
                        e.stopPropagation();
                        onIndexChange?.(index - 1);
                    }}
                    aria-label="이전 사진"
                >
                    ‹
                </button>
            )}
            {index < total - 1 && (
                <button
                    type="button"
                    className="photo-lightbox-nav next"
                    onClick={(e) => {
                        e.stopPropagation();
                        onIndexChange?.(index + 1);
                    }}
                    aria-label="다음 사진"
                >
                    ›
                </button>
            )}

            <figure className="photo-lightbox-fig" onClick={(e) => e.stopPropagation()}>
                <img src={photo.src} alt={photo.alt || ''} className="photo-lightbox-img" />
                <figcaption className="photo-lightbox-meta">
                    {photo.dept && <span className="photo-lightbox-dept">{photo.dept}</span>}
                    {photo.time && <span className="photo-lightbox-time">{photo.time}</span>}
                    <span className="photo-lightbox-counter">{index + 1} / {total}</span>
                </figcaption>
            </figure>
        </div>
    );
}
