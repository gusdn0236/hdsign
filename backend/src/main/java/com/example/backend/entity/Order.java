package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")
@Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 30)
    private String orderNumber;   // ORD-20250422-001 형태

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "client_id", nullable = false)
    private ClientUser client;

    @Column(length = 200)
    private String title;         // 작업명 (거래처가 입력, 선택사항)

    @Column(nullable = false)
    @Builder.Default
    private Boolean hasSMPS = false;

    @Column(columnDefinition = "TEXT")
    private String additionalItems;  // 추가 물품 (쉼표 구분)

    @Column(columnDefinition = "TEXT")
    private String note;          // 추가 요청사항

    @Column(nullable = false)
    private LocalDate dueDate;    // 납품 희망일

    @Column(length = 20)
    private String dueTime;       // 납품 시간대 (오전 중 / 오후 중 / 당일 내)

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 10)
    @Builder.Default
    private DeliveryMethod deliveryMethod = DeliveryMethod.CARGO;

    @Column(length = 255)
    private String deliveryAddress;  // 화물지점 or 주소

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private OrderStatus status = OrderStatus.RECEIVED;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @Builder.Default
    private List<OrderFile> files = new ArrayList<>();

    @CreationTimestamp
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    // ── 상태 ENUM ──
    public enum OrderStatus {
        RECEIVED,     // 접수완료
        IN_PROGRESS,  // 작업중
        COMPLETED     // 완료
    }

    // ── 납품방법 ENUM ──
    public enum DeliveryMethod {
        CARGO,   // 화물 발송
        QUICK,   // 퀵 발송
        DIRECT,  // 직접 배송
        PICKUP   // 직접 픽업
    }
}
