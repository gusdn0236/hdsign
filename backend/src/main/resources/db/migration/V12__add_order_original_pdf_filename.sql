-- 워처가 업로드한 지시서 PDF의 원본 파일명(예: "홍길동상사_LED간판.pdf").
-- 현장 뷰어 [FS에서 열기] 시 이 stem 으로 네트워크 폴더 안의 .fs 파일을 매칭한다.
ALTER TABLE orders ADD COLUMN original_pdf_filename VARCHAR(255) NULL;
