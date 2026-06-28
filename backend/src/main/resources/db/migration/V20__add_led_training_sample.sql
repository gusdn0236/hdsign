-- LED 개수 학습 샘플 저장소.
-- 현장에서 실제로 설치된 LED 개수를 벡터 외곽선(면적/둘레)과 함께 라벨링해 저장한다.
-- led_type(strip/g3/m2/mini3/g1/pcb 등) 단위로 쌓이며, 서버가 이 샘플들로 타입별
-- 회귀계수(면적당·둘레당 LED)를 최소제곱 적합해 프론트로 돌려준다(피드백 루프).
-- polys_json 은 원본 벡터 폴리곤 JSON 으로, 추후 모델 재적합을 위해 그대로 보관한다.
CREATE TABLE led_training_sample (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    led_type     VARCHAR(64)  NOT NULL,
    area         DOUBLE       NOT NULL,
    perim        DOUBLE       NOT NULL,
    actual_count INT          NOT NULL,
    order_number VARCHAR(255) NULL,
    polys_json   LONGTEXT     NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- led_type 단위 조회(타입별 계수 적합) 가속. 타입마다 샘플이 쌓여도 풀스캔 회피.
    INDEX idx_led_training_sample_led_type (led_type)
);
