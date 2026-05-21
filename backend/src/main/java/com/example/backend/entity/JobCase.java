package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 작업 사례 — 완료된 작업 한 건의 기록. 견적 AI 의 학습 재료다.
 *
 * <p>핵심 발상(잔차 모델): 최종가에서 명시적으로 아는 비용(자재비 등)을 빼면
 * "무형의 공정 비용"(인건·노하우·난이도)이 남는다. 이 잔차를 사이즈·재질·공정 설명과
 * 함께 사례로 쌓으면, 비슷한 공정의 새 작업에 비슷한 잔차를 적용해 견적을 낼 수 있다.
 *
 * <p>과거 작업 역입력도 신규 작업도 같은 구조로 기록한다.
 */
@Entity
@Table(name = "job_cases")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class JobCase {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 200)
    private String title;

    // 등록 거래처면 연결. 미등록이면 null 이고 clientName 만.
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "client_id")
    private ClientUser client;

    @Column(length = 200)
    private String clientName;

    // 공정 설명 — 작업이 어떤 식으로 굴러갔는지 자유 서술. AI 의 핵심 검색·추론 키.
    @Column(columnDefinition = "TEXT")
    private String description;

    // 작업 사이즈 — 자유 텍스트(작업마다 치수 표현이 달라 구조화하지 않는다).
    @Column(length = 200)
    private String sizeText;

    // 재질 / 주요 자재.
    @Column(length = 200)
    private String material;

    // 최종 청구가(명세표 기준 실제 받은 금액).
    @Column(nullable = false)
    @Builder.Default
    private Long finalPrice = 0L;

    // 작업일 / 납품일.
    @Column
    private LocalDate jobDate;

    @Column(columnDefinition = "TEXT")
    private String note;

    // 명시적으로 아는 비용 항목들(자재비 등). 최종가 − 이 합 = 무형 공정 비용(잔차).
    @OneToMany(mappedBy = "jobCase", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("sortOrder ASC, id ASC")
    @Builder.Default
    private List<JobCaseCost> costs = new ArrayList<>();

    @CreationTimestamp
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;
}
