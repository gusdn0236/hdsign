-- 지시서 재반영 횟수(n차 수정). 첫 등록 0, 웹 재반영마다 +1 — 워처 카톡 '(지시서 n차 수정됨)'.
-- 기존 행은 NULL(=모름) 으로 두고, 다음 재반영부터 0 기준으로 센다(이미 수정된 적 있으면 worksheet_revised_at 존재).
ALTER TABLE orders ADD COLUMN worksheet_revision_count INT NULL;
