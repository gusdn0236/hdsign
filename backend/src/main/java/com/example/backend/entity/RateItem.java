package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

/**
 * 단가 마스터 한 항목 — 회사가 유지하는 원가 단가의 단위.
 *
 * <p>공정 기반 견적의 각 줄(공정 단계)은 이 단가를 끌어와 금액을 산출한다.
 * 이 표가 "회사 비용을 학습시킨다"의 실체이고 회사의 핵심 자산이다 — 정확할수록 견적이 정확해진다.
 *
 * <ul>
 *   <li>MATERIAL  : 자재 단가 (예: 스텐폴리싱 1.2t 4×8판 = 판당 OO원)</li>
 *   <li>LABOR     : 공정별 시간당 비용 (예: 레이저CNC 가공 = 시간당 OO원, 장비+인건 포함)</li>
 *   <li>OUTSOURCE : 외주 단가 (예: 발색 = ㎡당 OO원, 외주처별로 다름)</li>
 *   <li>EXTRA     : 부대비용 (예: 퀵·택배·출장)</li>
 * </ul>
 */
@Entity
@Table(name = "rate_items")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class RateItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private RateType rateType = RateType.MATERIAL;

    // 항목명 (스텐폴리싱 1.2t / 레이저CNC 가공 / 발색 / 퀵 배송).
    @Column(nullable = false, length = 200)
    private String name;

    // 규격 — 자재 판 규격 등. 선택.
    @Column(length = 200)
    private String spec;

    // 외주처 — OUTSOURCE 항목용. 선택.
    @Column(length = 120)
    private String vendor;

    // 단위 (판 / 장 / 시간 / ㎡ / 건 / 식 / kg ...).
    @Column(length = 20)
    private String unit;

    // 단가 (원). LABOR 는 시간당 비용.
    @Column(nullable = false)
    @Builder.Default
    private Long unitPrice = 0L;

    // 분류 — 그룹핑/검색용. 선택 (예: 스텐, 아크릴, 갈바).
    @Column(length = 100)
    private String category;

    @Column(columnDefinition = "TEXT")
    private String note;

    // false 면 견적 작성 시 후보에서 숨김(단종 자재 등). 이미 작성된 견적의 줄에는 영향 없음.
    @Column(nullable = false)
    @Builder.Default
    private Boolean active = true;

    @CreationTimestamp
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    public enum RateType {
        MATERIAL,   // 자재
        LABOR,      // 가공·인건 (시간당)
        OUTSOURCE,  // 외주
        EXTRA       // 부대비용
    }
}
