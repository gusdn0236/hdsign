-- 워처가 인쇄(웹반영) 시 .fs 를 DXF('외부 파일로 저장')로 내보내 추출한
-- '오브젝트별 가로세로(mm)' 지오메트리 JSON 의 R2 URL.
-- 명세서 작성 화면에서 지시서 사진 위에 클릭하면 치수 오버레이로 보여준다.
-- PDF 업로드와 별개로(겹치기 설계) 업로드되며, DXF 추출 실패 시 비어 있을 수 있다(부차 기능).
ALTER TABLE orders ADD COLUMN worksheet_objects_url VARCHAR(500) NULL;
