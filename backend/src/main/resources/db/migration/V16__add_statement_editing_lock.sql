-- 명세서 작성 잠금(소프트 락) — 두 명이 같은 작업카드의 명세서를 동시에 작성하는 중복작업 방지.
-- 명세서 모달을 연 관리자 username/표시이름/마지막 하트비트 시각을 기록한다. 모달을 닫으면 비우고,
-- TTL(서버 90초) 지나도록 하트비트가 없으면 stale 로 보고 무시 — 탭을 그냥 닫아도 자동 만료된다.
ALTER TABLE orders ADD COLUMN statement_editing_by VARCHAR(100) NULL;
ALTER TABLE orders ADD COLUMN statement_editing_name VARCHAR(100) NULL;
ALTER TABLE orders ADD COLUMN statement_editing_at DATETIME NULL;
