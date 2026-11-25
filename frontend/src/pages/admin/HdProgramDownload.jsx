import React, { useEffect, useRef, useState } from 'react';

// 관리자 화면 맨 오른쪽 위 'HD프로그램 다운로드' 드롭다운.
// 받는 건 작은 설치 .bat — 회사 공유폴더(\Main\현대공유 = Z:)의 바로가기를 이 PC 바탕화면에
// 복사하고 바로 실행한다. 프로그램 본체는 바로가기 실행 때마다 Z: 에서 최신본으로 자동 갱신되므로
// 여기서 .exe 를 직접 나눠줄 필요가 없다(회사 네트워크 PC 에서만 동작).
// 예외: '명세서 작성용' = 이지폼 전용 경량 에이전트 exe 를 그대로 받는다(Z: 없이 집·외부 PC 에서 이지폼 ↔ 홈페이지).
// exe 원본은 hdsign-watcher/dist_agent(빌드: pyinstaller hdsign_easyform_agent.spec), git 에는 안 넣고 배포 때만 올린다.
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
    {
        key: 'easyform',
        name: '명세서 작성용',
        desc: '이지폼 ↔ 홈페이지 명세서 반영만 · 집·외부 PC (Z: 필요 없음)',
        logo: `${BASE}downloads/hd-logo-easyform.png`,
        href: `${BASE}downloads/hdsign-easyform-agent.exe`,
        file: 'HD사인_명세서작성.exe',
    },
];

// 이 PC 에 켜진 '명세서 작성용' 이 최신 배포본보다 옛것인지 확인.
// 최신 = downloads/easyform-agent-version.json(build_easyform_agent.py 가 exe 와 함께 기록),
// 켜진 것 = 127.0.0.1:5577/ping 의 version(버전 없는 옛 빌드도 '옛것'으로 본다).
// 사무실용 워처(app=hdsign_worksheet)가 떠 있으면 Z: 에서 자동 갱신되므로 표시 안 함. 안 켜져 있으면 알 수 없으니 표시 안 함.
const EF_VERSION_URL = `${BASE}downloads/easyform-agent-version.json`;

async function checkEasyformOutdated() {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch('http://127.0.0.1:5577/ping', { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) return false;
        const ping = await res.json();
        if (ping?.app !== 'hdsign_easyform_agent' || ping?.version === 'dev') return false;
        const latestRes = await fetch(EF_VERSION_URL, { cache: 'no-store' });
        if (!latestRes.ok) return false;
        const latest = (await latestRes.json())?.version;
        return !!latest && ping.version !== latest;
    } catch {
        return false;
    }
}

const HdProgramDownload = () => {
    const [open, setOpen] = useState(false);
    const [efOutdated, setEfOutdated] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        let alive = true;
        const run = () => { checkEasyformOutdated().then((v) => { if (alive) setEfOutdated(v); }); };
        run();
        const onFocus = () => run();
        window.addEventListener('focus', onFocus);
        const iv = setInterval(run, 5 * 60 * 1000);
        return () => {
            alive = false;
            window.removeEventListener('focus', onFocus);
            clearInterval(iv);
        };
    }, []);

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
                {efOutdated && <span className="hd-dl-dot" title="명세서 작성용 업데이트 필요" />}
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
                                <strong>
                                    {it.name}
                                    {it.key === 'easyform' && efOutdated && (
                                        <span className="hd-dl-update">⬆ 업데이트 필요</span>
                                    )}
                                </strong>
                                <small>
                                    {it.key === 'easyform' && efOutdated
                                        ? '켜진 프로그램이 옛 버전이에요. 창을 닫고 새로 받은 걸 켜 주세요.'
                                        : it.desc}
                                </small>
                            </span>
                        </a>
                    ))}
                    <p className="hd-dl-note">
                        사무실용·현장용: 받은 파일을 실행하면 바탕화면에 바로가기가 생기고 바로 켜집니다.
                        회사 공유폴더(Z:)에 연결된 PC에서만 됩니다.
                        <br />
                        명세서 작성용: 이지폼이 깔린 PC에서 받은 프로그램을 켜 두면 됩니다(설치 없음).
                        사무실용이 켜진 PC에선 필요 없어요. 새 버전이 나오면 다시 받아 주세요.
                    </p>
                </div>
            )}
        </div>
    );
};

export default HdProgramDownload;
