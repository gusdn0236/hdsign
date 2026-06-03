-- 자동견적 명세서(estimate) 저장소 — 주문(지시서)별로 작성한 견적 명세서 grid 를 보관.
-- 관리자가 주문 상세모달의 "명세서작성"으로 /admin/autoquote 에서 작성/수정한 명세서가
-- 여기 1:1(주문당 1건)로 저장된다. 작업중/작업완료 어느 상태든 공용.
--
-- ADDITIVE ONLY: 기존 orders 테이블/마이그레이션은 건드리지 않고 신규 테이블만 추가한다
-- (danger zone 보호 — RateItem/JobCase/기존 V1..V13 불변).
--
-- grid_json  : 명세서 grid(월일·품목코드·품목·규격·수량·단가·공급가·세액·비고 등) 전체 JSON.
-- easyform_uploaded_at : slice-14 이지폼 매크로가 업로드 완료를 표시한 시각(미업로드면 NULL).
CREATE TABLE autoquote_estimate (
    id                   BIGINT       NOT NULL AUTO_INCREMENT,
    order_id             BIGINT       NOT NULL,
    grid_json            LONGTEXT     NOT NULL,
    saved_at             DATETIME     NOT NULL,
    easyform_uploaded_at DATETIME     NULL,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- 주문당 명세서 1건(upsert). order_id 로 조회/유일성 보장.
    UNIQUE KEY uq_autoquote_estimate_order_id (order_id)
);
