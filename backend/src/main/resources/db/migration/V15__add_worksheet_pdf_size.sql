-- 작업지시서 PDF(worksheetPdfUrl) 의 바이트 크기. 발주관리/카드에 작게 표시해 비정상 대용량
-- 업로드(예: 압축 안 된 사진으로 수백 MB → 백엔드 OOM)를 한눈에 식별하기 위함. NULL = 기존(미측정) 건.
ALTER TABLE orders ADD COLUMN worksheet_pdf_size BIGINT;
