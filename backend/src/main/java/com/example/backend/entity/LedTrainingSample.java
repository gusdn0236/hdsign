package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

/**
 * LED 개수 학습 샘플 — 현장에서 실제로 설치된 LED 개수를 벡터 외곽선(면적/둘레)과 함께 라벨링한 기록.
 *
 * <p>관리자가 명세서작성 단계에서 지시서 벡터로 자동 추정한 LED 개수를 실제 설치값으로 교정해 제출하면,
 * led_type(예: strip/g3/m2/mini3/g1/pcb) 단위로 여기에 쌓인다. 서버는 이 샘플들로 타입별
 * 회귀계수(면적당·둘레당 LED)를 최소제곱 적합해 프론트로 돌려준다(피드백 루프).
 *
 * <p>{@code polysJson} 은 원본 벡터 폴리곤 JSON 으로, 추후 모델 재적합(re-fitting)을 위해 그대로 보관한다.
 * 매핑 컬럼은 Flyway {@code V20__add_led_training_sample.sql} 와 1:1 대응한다.
 */
@Entity
@Table(
        name = "led_training_sample",
        indexes = {
                // led_type 단위 조회(타입별 계수 적합) 가속 — V20 의 인덱스와 동일.
                @Index(name = "idx_led_training_sample_led_type", columnList = "ledType")
        }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class LedTrainingSample {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "led_type", nullable = false, length = 64)
    private String ledType;

    /** 벡터 외곽선 면적(mm^2). */
    @Column(nullable = false)
    private double area;

    /** 벡터 외곽선 둘레(mm). */
    @Column(nullable = false)
    private double perim;

    @Column(name = "actual_count", nullable = false)
    private int actualCount;

    @Column(name = "order_number", length = 255)
    private String orderNumber;

    @Column(name = "polys_json", columnDefinition = "LONGTEXT")
    private String polysJson;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
