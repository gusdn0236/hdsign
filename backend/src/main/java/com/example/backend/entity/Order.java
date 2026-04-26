package com.example.backend.entity;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "orders")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 30)
    private String orderNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private RequestType requestType = RequestType.ORDER;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "client_id", nullable = false)
    private ClientUser client;

    @Column(length = 200)
    private String title;

    @Column(nullable = false)
    @Builder.Default
    private Boolean hasSMPS = false;

    @Column(columnDefinition = "TEXT")
    private String additionalItems;

    @Column(columnDefinition = "TEXT")
    private String note;

    @Column
    private LocalDate dueDate;

    @Column(length = 20)
    private String dueTime;

    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private DeliveryMethod deliveryMethod;

    @Column(length = 255)
    private String deliveryAddress;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private OrderStatus status = OrderStatus.RECEIVED;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @Builder.Default
    private List<OrderFile> files = new ArrayList<>();

    @Column(length = 500)
    private String worksheetPdfUrl;

    // 작업자가 QR로 evidence 사진 업로드한 가장 최근 시각.
    // 관리자 모달에서 adminViewedAt 보다 이 시각이 늦으면 행에 "신규 사진" 배지 표시.
    @Column
    private LocalDateTime evidenceLastUploadedAt;

    // 워처가 PDF24로 지시서 PDF를 (재)업로드한 시각. 납기/지시서 변경의 최종 신호.
    @Column
    private LocalDateTime worksheetUpdatedAt;

    // 관리자가 마지막으로 모달을 열어 본 시각. 위 두 시각보다 늦으면 배지가 사라진다.
    @Column
    private LocalDateTime adminViewedAt;

    @CreationTimestamp
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    @Column
    private LocalDateTime deletedAt;

    public enum RequestType {
        ORDER,
        QUOTE
    }

    public enum OrderStatus {
        RECEIVED,
        IN_PROGRESS,
        COMPLETED
    }

    public enum DeliveryMethod {
        CARGO,
        QUICK,
        DIRECT,
        PICKUP,
        LOCAL_CARGO
    }
}
