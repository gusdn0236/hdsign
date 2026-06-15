-- 워처가 인쇄(웹반영) 시점에 그 .fs 파일에 새로 발급해 박은 전역 고유 ID(uuid hex).
-- 같은 값을 .fs 의 NTFS ADS(hdsign.fsuid)에도 기록해, 현장 뷰어 [FS에서 열기] 가 파일명이
-- 바뀌거나 폴더 안에서 옮겨져도 이 UID 로 .fs 를 정확히 찾는다. 주문번호와 독립 — 인쇄마다 갱신.
ALTER TABLE orders ADD COLUMN original_fs_uid VARCHAR(64) NULL;
