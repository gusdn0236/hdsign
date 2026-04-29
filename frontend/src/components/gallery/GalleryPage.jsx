import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import './GalleryPage.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const staticGalleryModules = import.meta.glob('../../assets/img/gallery/**/*.{jpg,jpeg,png,webp}', {
    eager: true,
    import: 'default',
});

const STATIC_SUB_CATEGORY_BY_PATH = [
    ['/gallery/galva/halo/', 'galva', '갈바 전/후광'],
    ['/gallery/galva/osai/', 'galva', '갈바 오사이'],
    ['/gallery/galva/cap/', 'galva', '갈바 측광'],
    ['/gallery/galva/integrated/', 'aluminum', '일체형채널'],
    ['/gallery/stainless/halo/', 'stainless', '스텐 전/후광'],
    ['/gallery/stainless/osai/', 'stainless', '스텐 오사이'],
    ['/gallery/stainless/cap/', 'stainless', '스텐 측광'],
    ['/gallery/stainless/gold/', 'stainless', '골드스텐'],
    ['/gallery/epoxy/galva/', 'epoxy', '갈바 에폭시'],
    ['/gallery/epoxy/stainless/', 'epoxy', '스텐에폭시'],
    ['/gallery/special/acrylic/', 'special', '아크릴/포맥스'],
    ['/gallery/special/foamex/', 'special', '아크릴/포맥스'],
    ['/gallery/special/rubber/', 'special', '고무스카시'],
];

const staticGalleryImages = Object.entries(staticGalleryModules).reduce((items, entry, index) => {
    const [path, imageUrl] = entry;
    const normalizedPath = path.replaceAll('\\', '/');
    const match = STATIC_SUB_CATEGORY_BY_PATH.find(([segment]) => normalizedPath.includes(segment));
    if (!match) return items;

    const [, category, subCategory] = match;
    const originalName = decodeURIComponent(normalizedPath.split('/').pop() || 'gallery-image');
    items.push({
        id: `static-${index}`,
        category,
        subCategory,
        imageUrl,
        originalName,
    });
    return items;
}, []);

function getStaticGalleryImages(category) {
    return staticGalleryImages.filter(function(img) {
        return img.category === category;
    });
}

const GalleryPage = ({ category, categoryTabs }) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = parseInt(searchParams.get('tab')) || 0;
    const [activeTab, setActiveTab] = useState(tabParam);
    const [images, setImages] = useState(function() { return getStaticGalleryImages(category); });
    const [loading, setLoading] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(null);
    const scrollRef = useRef(null);

    useEffect(() => {
        const tab = parseInt(searchParams.get('tab')) || 0;
        setActiveTab(tab);
        setSelectedIndex(null);
    }, [searchParams]);

    useEffect(() => {
        const staticImages = getStaticGalleryImages(category);
        const shouldFetchRemote = !import.meta.env.DEV || !BASE_URL.includes('localhost');

        setImages(staticImages);
        if (!shouldFetchRemote) {
            setLoading(false);
            return;
        }

        setLoading(staticImages.length === 0);
        fetch(BASE_URL + '/api/gallery?category=' + category)
            .then(function(res) {
                if (!res.ok) throw new Error('이미지 목록을 불러오지 못했습니다.');
                return res.json();
            })
            .then(function(data) {
                setImages(Array.isArray(data) && data.length > 0 ? data : staticImages);
                setLoading(false);
            })
            .catch(function() {
                setImages(staticImages);
                setLoading(false);
            });
    }, [category]);

    const currentSubCategory = categoryTabs[activeTab] ? categoryTabs[activeTab].subCategory : null;
    const currentImages = currentSubCategory
        ? images.filter(function(img) { return img.subCategory === currentSubCategory; })
        : images;

    const totalImages = currentImages.length;
    const openModal = function(index) { setSelectedIndex(index); };
    const closeModal = useCallback(function() { setSelectedIndex(null); }, []);
    const goPrev = useCallback(function() {
        if (selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    }, [selectedIndex]);
    const goNext = useCallback(function() {
        if (selectedIndex < totalImages - 1) setSelectedIndex(selectedIndex + 1);
    }, [selectedIndex, totalImages]);

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
    }, [selectedIndex, goPrev, goNext, closeModal]);

    // 모달이 열려있는 동안 배경(body) 스크롤을 잠근다.
    // iOS Safari 에서는 overflow:hidden 만으로 부족하므로 position:fixed + 스크롤 좌표 복원.
    React.useEffect(function() {
        if (selectedIndex === null) return undefined;
        const scrollY = window.scrollY;
        const body = document.body;
        const prev = {
            position: body.style.position,
            top: body.style.top,
            left: body.style.left,
            right: body.style.right,
            width: body.style.width,
            overflow: body.style.overflow,
        };
        body.style.position = 'fixed';
        body.style.top = '-' + scrollY + 'px';
        body.style.left = '0';
        body.style.right = '0';
        body.style.width = '100%';
        body.style.overflow = 'hidden';
        return function() {
            body.style.position = prev.position;
            body.style.top = prev.top;
            body.style.left = prev.left;
            body.style.right = prev.right;
            body.style.width = prev.width;
            body.style.overflow = prev.overflow;
            window.scrollTo(0, scrollY);
        };
    }, [selectedIndex]);

    // 모바일에서 사진 영역을 좌우로 스와이프하면 이전/다음 사진으로 이동.
    const touchStartRef = useRef(null);
    const handleTouchStart = function(e) {
        const t = e.touches[0];
        touchStartRef.current = { x: t.clientX, y: t.clientY };
    };
    const handleTouchEnd = function(e) {
        const start = touchStartRef.current;
        if (!start) return;
        touchStartRef.current = null;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        // 수평 이동이 50px 넘고, 세로보다 가로가 더 크게 움직였을 때만 스와이프로 인정.
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
            if (dx < 0) goNext();
            else goPrev();
        }
    };

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
                                React.createElement('img', {
                                    src: img.imageUrl,
                                    alt: img.originalName,
                                    // 뷰포트 진입 시에만 다운로드 — 한 탭에 100장 깔려 있어도
                                    // 첫 화면에 보이는 ~12장만 즉시 로드, 나머지는 스크롤 시 로드.
                                    loading: 'lazy',
                                    decoding: 'async'
                                }),
                                React.createElement('div', { className: 'gallery-item-overlay' },
                                    React.createElement('span', { className: 'gallery-item-icon' }, '\uD83D\uDD0D')
                                )
                            );
                        })
                    )
                    : React.createElement('div', { className: 'gallery-empty' }, React.createElement('p', null, '\uC900\uBE44 \uC911\uC785\uB2C8\uB2E4.')),
            selectedIndex !== null
                ? React.createElement('div', {
                    className: 'gallery-modal',
                    onClick: closeModal,
                    onTouchStart: handleTouchStart,
                    onTouchEnd: handleTouchEnd
                },
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
