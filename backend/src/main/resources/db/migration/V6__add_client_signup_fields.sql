-- 거래처 회원가입 흐름 도입.
--   1) username 을 NULL 허용으로 변경 — PENDING_SIGNUP 행은 username 이 비어있다.
--      MySQL 의 UNIQUE 제약은 NULL 다중 허용이므로 그대로 둔다.
--   2) status: 가입 단계 enum (PENDING_SIGNUP / PENDING_APPROVAL / ACTIVE / DISABLED).
--      기존 행은 ACTIVE 로 마이그레이션 (is_active=false 인 행은 DISABLED).
--   3) password_plaintext: 자동생성된 임시 비번을 평문으로 보관 — 분실 문의 시 관리자만 조회.
--      거래처가 자기 평소 비번을 정하지 못하므로(우리가 무작위 발급), 이 평문 유출의
--      파급은 본 사이트 무단 접근에 한정. BCrypt 해시(password)는 그대로 유지해 로그인 검증에 사용.
--   4) signup_requested_at: 가입 신청이 들어온 시각 — 관리자 화면 정렬/감사용.

ALTER TABLE client_users MODIFY COLUMN username VARCHAR(50) NULL;

ALTER TABLE client_users
    ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN password_plaintext VARCHAR(50) NULL,
    ADD COLUMN signup_requested_at DATETIME NULL;

UPDATE client_users SET status = 'DISABLED' WHERE is_active = FALSE;
