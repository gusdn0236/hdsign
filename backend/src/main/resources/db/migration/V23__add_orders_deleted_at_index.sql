-- 작업완료(deleted_at) 30일 창 조회·'더보기' 존재 확인·보관만료 정리가 전부 deleted_at 범위 조건.
-- 보관 3년으로 늘면서 행이 쌓여도 풀스캔하지 않도록 인덱스.
CREATE INDEX idx_orders_deleted_at ON orders (deleted_at);
