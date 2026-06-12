-- 명세서 작성자 표시이름 — 임시저장/이지폼 입력을 마지막으로 누른 사람 이름을 카드 배지에
-- "ㅇㅇㅇ님: 임시저장" / "ㅇㅇㅇ님: 명세서 완료" 로 보여주기 위함. 명세서 작성 잠금과 같은
-- PC별 이름(각 PC localStorage)을 클라이언트가 보낸다. 저장·이지폼 매 단계에서 덮어쓴다.
ALTER TABLE autoquote_estimate ADD COLUMN editor_name VARCHAR(100) NULL;
