-- 지시서 변경 웹푸시 구독 테이블.
-- endpoint 는 브라우저/기기가 발급한 push 구독 URL — 기기 단위 고유 식별자 역할.
CREATE TABLE push_subscriptions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    endpoint VARCHAR(500) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    -- ALL: 모든 지시서 변경 알림 / MINE: 본인 슬롯 매칭 지시서만 / OFF 상태는 row 자체를 삭제.
    mode VARCHAR(16) NOT NULL,
    -- mode=MINE 일 때만 사용. workers.js 의 직원 이름과 동일 문자열.
    worker VARCHAR(64) NULL,
    created_at DATETIME NOT NULL,
    CONSTRAINT uq_push_subscriptions_endpoint UNIQUE (endpoint)
);
