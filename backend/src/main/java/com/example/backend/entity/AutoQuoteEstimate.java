package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

/**
 * 자동견적 명세서(estimate) — 주문(지시서) 1건당 1개의 견적 명세서 grid 를 보관.
 *
 * <p>관리자가 주문 상세모달의 "명세서작성" 으로 {@code /admin/autoquote} 에서 작성/수정한
 * 명세서가 {@code orderId} 단위 1:1 로 저장된다(작업중/작업완료 공용). {@code gridJson} 은
 * 명세서 grid 전체(월일·품목코드·품목·규격·수량·단가·공급가·세액·비고 등)를 직렬화한 JSON 문자열.
 *
 * <p>매핑 컬럼은 Flyway {@code V14__add_autoquote_estimate.sql} 와 1:1 대응한다.
 * ADDITIVE ONLY — 기존 {@code orders}/RateItem/JobCase 테이블과 무관한 신규 테이블.
 */
@Entity
@Table(
        name = "autoquote_estimate",
        uniqueConstraints = {
                // 주문당 명세서 1건(upsert) — V14 의 UNIQUE KEY 와 동일.
                @UniqueConstraint(name = "uq_autoquote_estimate_order_id", columnNames = "orderId")
        }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class AutoQuoteEstimate {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "order_id", nullable = false)
    private Long orderId;

    @Column(name = "grid_json", nullable = false, columnDefinition = "LONGTEXT")
    private String gridJson;

    @Column(name = "saved_at", nullable = false)
    private LocalDateTime savedAt;

    /** slice-14 이지폼 매크로가 업로드 완료를 표시한 시각. 미업로드면 null. */
    @Column(name = "easyform_uploaded_at")
    private LocalDateTime easyformUploadedAt;

    /**
     * 마지막으로 이 명세서를 처리(임시저장 또는 이지폼 입력)한 작성자 표시이름. 명세서 작성 잠금과
     * 같은 PC별 이름(각 PC localStorage)을 클라이언트가 보낸다. 저장·이지폼 매 단계에서 덮어써,
     * "마지막에 이지폼으로 옮겨적은 사람" 이름이 최종으로 카드 배지에 뜨게 한다.
     */
    @Column(name = "editor_name", length = 100)
    private String editorName;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;
}
