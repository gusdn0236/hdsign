import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * 데모(둘러보기) 세션에서 "쓰기" 버튼을 회색·비활성화한다.
 *
 * 관리자/거래처 화면의 버튼은 200개가 넘고 대부분은 조회용(검색·필터·탭·복사 등)이라
 * 버튼마다 일일이 disabled 를 다는 건 비현실적이다. 대신 버튼 라벨/타입으로
 * "데이터를 바꾸는 버튼"을 자동 감지해 잠근다. 새로 뜨는 모달·목록 버튼까지
 * MutationObserver 로 따라잡는다.
 *
 * 안전망: 혹시 못 잡은 쓰기 버튼이 있어도 fetch 가드 + 백엔드 403 이 그대로 막으므로
 * 데이터는 절대 바뀌지 않는다. 이 컴포넌트는 "시각적으로 회색 + 클릭 차단" 담당.
 */

// 데이터를 바꾸는 동작을 가리키는 라벨 키워드.
const WRITE_RE =
    /(저장|삭제|추가|등록|수정|승인|거부|재발급|변경|발주|복구|요청하기|업로드|올리기|반영|발송|제출|확정|통합|비우기|생성|신청|작성|적용|내보내기|발행)/;

// 조회/네비게이션 버튼임을 나타내는 className 조각 — 매칭되면 잠그지 않는다.
const SAFE_CLASS_RE = /(tab|cancel|close|search|copy|prev|next|pag|toggle|logout|choice|sort|nav)/i;

// 라벨이 정확히 이 단어면(쓰기 키워드와 무관하게) 잠그지 않는다.
const SAFE_TEXT = new Set([
    '취소', '닫기', '확인', '복사', '검색', '새로고침', '초기화',
    '전체 선택', '전체 해제', '이전', '다음', '로그아웃', '오늘', '전체 보기',
]);

function isWriteButton(btn) {
    const cls = typeof btn.className === 'string' ? btn.className : '';
    if (SAFE_CLASS_RE.test(cls)) return false;
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (SAFE_TEXT.has(text)) return false;
    if ((btn.getAttribute('type') || '').toLowerCase() === 'submit') return true;
    return WRITE_RE.test(text);
}

function lock(btn) {
    if (btn.dataset.demoLocked === '1') return;
    btn.dataset.demoLocked = '1';
    btn.style.opacity = '0.45';
    btn.style.filter = 'grayscale(1)';
    btn.style.cursor = 'not-allowed';
    btn.style.pointerEvents = 'none';
    btn.style.boxShadow = 'none';
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('tabindex', '-1');
    btn.title = '데모 계정에서는 사용할 수 없습니다';
}

export default function DemoButtonLock() {
    const { pathname } = useLocation();

    // 쓰기 버튼 스캔 — 진입 시 + 라우트 변경 시 + DOM 변경(모달·목록 렌더) 시.
    useEffect(() => {
        let raf = 0;
        const scan = () => {
            raf = 0;
            document.querySelectorAll('button').forEach((btn) => {
                if (btn.dataset.demoLocked === '1') return;
                if (isWriteButton(btn)) lock(btn);
            });
        };
        const schedule = () => {
            if (!raf) raf = requestAnimationFrame(scan);
        };
        scan();
        const obs = new MutationObserver(schedule);
        obs.observe(document.body, { childList: true, subtree: true });
        return () => {
            obs.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [pathname]);

    // 키보드(Enter/Space)·프로그램적 클릭까지 차단하는 캡처 단계 리스너.
    useEffect(() => {
        const block = (e) => {
            const btn = e.target.closest && e.target.closest('button[data-demo-locked="1"]');
            if (btn) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        document.addEventListener('click', block, true);
        return () => document.removeEventListener('click', block, true);
    }, []);

    return null;
}
