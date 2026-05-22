import React from 'react';

/**
 * 데모(둘러보기) 세션임을 알리는 상단 고정 띠.
 * 관리자/거래처 레이아웃에서 데모 토큰일 때만 렌더링한다.
 */
export default function DemoBanner() {
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
                textAlign: 'center',
                padding: '8px 14px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                letterSpacing: '-0.01em',
            }}
        >
            🔒 데모 계정으로 둘러보는 중입니다 · 저장·삭제 등 변경 기능은 동작하지 않습니다
        </div>
    );
}
