-- 명세서 [확인요청] — 임시저장하면서 '확인필요' 표시(카드 우측 상단 빨간 느낌표). 일반 임시저장·이지폼 반영 때 꺼짐(사용자 2026-11-26).
ALTER TABLE autoquote_estimate ADD COLUMN review_requested BOOLEAN NULL;
