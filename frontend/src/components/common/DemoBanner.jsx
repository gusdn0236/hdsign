import React from 'react';
import { Link, useLocation } from 'react-router-dom';

/**
 * 데모(둘러보기) 세션임을 알리는 상단 고정 띠.
 * 관리자/거래처 레이아웃에서 데모 토큰일 때만 렌더링한다.
 * 데모 계정은 로그인 시 양쪽 세션이 함께 열리므로, 반대편 페이지로 바로
 * 건너뛸 수 있는 전환 링크를 함께 보여준다.
 */
export default function DemoBanner() {
    const { pathname } = useLocation();
    const onAdmin = pathname.startsWith('/admin');
    const switchTo = onAdmin ? '/client/request' : '/admin/orders';
    const switchLabel = onAdmin ? '거래처 페이지 둘러보기' : '관리자 페이지 둘러보기';

    return (
        <div
            role="status"
            style={{
                position: 'sticky',
                top: 0,
                zIndex: 2000,
                width: '100%',
                background: 'linear-gradient(90deg, #f59e0b, #f97316)',
                color: '#1f1300',
                fontSize: '13.5px',
                fontWeight: 700,
                lineHeight: 1.4,
                padding: '8px 14px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                letterSpacing: '-0.01em',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '14px',
                flexWrap: 'wrap',
            }}
        >
            <span>🔒 데모 계정으로 둘러보는 중입니다 · 저장·삭제 등 변경 기능은 동작하지 않습니다</span>
            <Link
                to={switchTo}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'rgba(31,19,0,0.88)',
                    color: '#fff',
                    textDecoration: 'none',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    padding: '4px 12px',
                    borderRadius: '999px',
                    whiteSpace: 'nowrap',
                }}
            >
                {switchLabel} →
            </Link>
        </div>
    );
}
