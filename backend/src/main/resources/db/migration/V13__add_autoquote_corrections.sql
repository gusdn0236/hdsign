-- 자동견적 보정(correction) 공유 저장소.
-- 관리자가 엔진의 추천 단가를 손으로 고치면 그 사유와 함께 여기에 저장된다.
-- feature_key(품목 특징 키) 단위로 모든 관리자에게 "서버 공유"되어, 다음 견적부터
-- priority(낮을수록 우선) 순서로 적용된다(S5: server-shared persistence).
-- author 는 인증된 관리자 principal 에서 서버가 박는다 — 클라이언트 본문 값은 신뢰하지 않는다.
CREATE TABLE autoquote_correction (
    id                  BIGINT          NOT NULL AUTO_INCREMENT,
    feature_key         VARCHAR(255)    NOT NULL,
    corrected_unit_price DECIMAL(12, 2) NOT NULL,
    explanation         TEXT            NOT NULL,
    author              VARCHAR(128)    NOT NULL,
    priority            INT             NOT NULL DEFAULT 100,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- feature_key 단위 조회(특정 품목의 보정 모음) 가속. 한 품목에 여러 보정이 쌓여도 풀스캔 회피.
    INDEX idx_autoquote_correction_feature_key (feature_key)
);
