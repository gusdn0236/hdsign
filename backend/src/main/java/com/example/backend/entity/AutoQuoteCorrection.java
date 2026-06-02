package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 자동견적 보정(correction) — 관리자가 엔진 추천 단가를 손으로 고친 기록.
 *
 * feature_key(품목 특징 키) 단위로 모든 관리자에게 서버 공유되며, 다음 견적부터
 * {@code priority}(낮을수록 우선) 순서로 적용된다. {@code author} 는 인증된 관리자
 * principal 에서 서버가 박는다 — 클라이언트 본문 값은 신뢰하지 않는다(스푸핑 불가).
 *
 * 매핑 컬럼은 Flyway {@code V13__add_autoquote_corrections.sql} 와 1:1 대응한다.
 */
@Entity
@Table(
        name = "autoquote_correction",
        indexes = {
                // feature_key 단위 조회(특정 품목의 보정 모음) 가속 — V13 의 인덱스와 동일.
                @Index(name = "idx_autoquote_correction_feature_key", columnList = "featureKey")
        }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class AutoQuoteCorrection {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "feature_key", nullable = false, length = 255)
    private String featureKey;

    @Column(name = "corrected_unit_price", nullable = false, precision = 12, scale = 2)
    private BigDecimal correctedUnitPrice;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String explanation;

    @Column(nullable = false, length = 128)
    private String author;

    @Column(nullable = false)
    private Integer priority;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
