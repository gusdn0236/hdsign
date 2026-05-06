package com.example.backend.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

/**
 * 모바일 [작업완료] 신고 1건. 한 지시서를 여러 직원이 각자 따로 처리할 수 있는
 * per-worker independent 모델 — 김진섭이 누른다고 김명수에게서 사라지지 않음.
 *
 * <p>unique(order_id, worker) — 같은 직원이 같은 지시서를 두 번 누르면 두 번째는
 * 멱등으로 무시(controller 에서 처리). 동일 직원이 다른 지시서엔 당연히 여러 row.
 */
@Entity
@Table(
        name = "worker_completions",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_worker_completions_order_worker",
                columnNames = {"order_id", "worker"}
        )
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WorkerCompletion {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @Column(nullable = false, length = 50)
    private String worker;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private LocalDateTime completedAt;
}
