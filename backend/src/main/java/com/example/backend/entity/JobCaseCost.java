package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;

/**
 * 작업 사례의 명시적 비용 한 줄 — 자재비 등 "아는 비용".
 * 작업 사례의 최종가에서 이 항목들의 합을 빼면 무형 공정 비용(잔차)이 된다.
 */
@Entity
@Table(name = "job_case_costs")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class JobCaseCost {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "job_case_id", nullable = false)
    private JobCase jobCase;

    @Column(nullable = false)
    @Builder.Default
    private Integer sortOrder = 0;

    // 비용 항목명 (예: "스텐폴리싱 1.2t 자재").
    @Column(length = 200)
    private String label;

    @Column(nullable = false)
    @Builder.Default
    private Long amount = 0L;
}
