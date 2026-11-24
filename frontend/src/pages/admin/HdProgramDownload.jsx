import React, { useEffect, useRef, useState } from 'react';

// 관리자 화면 맨 오른쪽 위 'HD프로그램 다운로드' 드롭다운.
// 받는 건 작은 설치 .bat — 회사 공유폴더(\Main\현대공유 = Z:)의 바로가기를 이 PC 바탕화면에
// 복사하고 바로 실행한다. 프로그램 본체는 바로가기 실행 때마다 Z: 에서 최신본으로 자동 갱신되므로
// 여기서 .exe 를 직접 나눠줄 필요가 없다(회사 네트워크 PC 에서만 동작).
const BASE = import.meta.env.BASE_URL || '/';
const ITEMS = [
    {
        key: 'office',
        name: '사무실용',
        desc: '지시서 자동작성 (일러스트 → 플렉사인)',
        logo: `${BASE}downloads/hd-logo-office.png`,
        href: `${BASE}downloads/hdsign-office-setup.bat`,
        file: 'HD사인_사무실용_설치.bat',
    },
    {
        key: 'field',
        name: '현장용',
        desc: '작업뷰어 사이드바 (플렉사인에서 열기)',
        logo: `${BASE}downloads/hd-logo-field.png`,
        href: `${BASE}downloads/hdsign-field-setup.bat`,
        file: 'HD사인_현장용_설치.bat',
    },
];

const HdProgramDownload = () => {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div className="hd-dl" ref={ref}>
            <button
                type="button"
                className="hd-dl-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
            >
                HD프로그램 다운로드 <span className="hd-dl-caret">▾</span>
            </button>
            {open && (
                <div className="hd-dl-menu" role="menu">
                    {ITEMS.map((it) => (
                        <a
                            key={it.key}
                            role="menuitem"
                            className="hd-dl-item"
                            href={it.href}
                            download={it.file}
                            onClick={() => setOpen(false)}
                        >
                            <img className="hd-dl-logo" src={it.logo} alt="" width="36" height="36" />
                            <span className="hd-dl-text">
                                <strong>{it.name}</strong>
                                <small>{it.desc}</small>
                            </span>
                        </a>
                    ))}
                    <p className="hd-dl-note">
                        받은 파일을 실행하면 바탕화면에 바로가기가 생기고 바로 켜집니다.
                        회사 공유폴더(Z:)에 연결된 PC에서만 됩니다.
                    </p>
                </div>
            )}
        </div>
    );
};

export default HdProgramDownload;
