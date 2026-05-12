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

    // iOS/Safari 계열 모바일 뷰어용 원본 PDF. Android 에는 worksheetPdfUrl(평탄화본)을 우선 제공.
    @Column(length = 500)
    private String worksheetOriginalPdfUrl;

    // PDF 1페이지를 작은 JPEG 으로 변환한 R2 URL — admin/모바일 목록 카드용. 풀 PDF 는 카드 클릭 후만 다운로드.
    @Column(length = 500)
    private String worksheetThumbnailUrl;

    // 워처가 업로드한 지시서 PDF 의 원본 파일명(예: "홍길동상사_LED간판.pdf").
    // 현장 뷰어 [FS에서 열기] 시 거래처 네트워크 폴더 안에서 동일 stem 의 .fs 파일을
    // 찾아 FlexiSIGN 으로 여는 데 사용. .ai → .pdf 변환 시 stem 이 보존되고,
    // FlexiSIGN 사용자가 처음 저장한 .fs 도 통상 같은 stem 을 유지한다는 가정에 기반.
    @Column(length = 255)
    private String originalPdfFilename;

    // 워처 인쇄 다이얼로그 "지시서 내용 변경" 선택 시 작업자가 입력한 변경 메모.
    // 모바일 뷰어에서 PDF 한 번 터치하면 노출되어 작업자가 무엇이 바뀌었는지 즉시 본다.
    // 신규작성/단순 납기변경 업로드가 들어오면 다시 비워서 "최신 변경분만" 떠 있게 한다.
    @Column(columnDefinition = "TEXT")
    private String worksheetChangeNote;

    // 워처 인쇄 다이얼로그에서 직원이 분배함 칸을 클릭해 지정한 부서 태그(CSV).
    // 모바일 뷰어에서 부서 단위로 "내 지시서만 보기" 필터링에 사용.
    // 한 지시서가 여러 부서를 거치므로 다중 태그 허용. 빈/null 이면 태그 없음(전체보기에서만 노출).
    @Column(columnDefinition = "TEXT")
    private String departmentTags;

    // 워처가 직원이 클릭한 분배함 슬롯 라벨 자체를 CSV 로 저장(예: "시트/도안실,도장실").
    // departmentTags 는 mapped_dept(부서) 단위라 같은 부서에 여러 슬롯이 매핑된 경우
    // 어느 슬롯을 클릭했는지 정보가 사라진다 — 다이얼로그에서 지시서를 다시 불러올 때
    // 정확히 그 슬롯에만 ✓ 를 복원하기 위해 라벨 단위로 별도 보관.
    // 모바일 뷰어 필터는 여전히 departmentTags(부서) 를 사용하므로 모바일 동작은 변화 없음.
    @Column(columnDefinition = "TEXT")
    private String departmentSlots;

    // 작업자가 QR로 evidence 사진 업로드한 가장 최근 시각.
    // 관리자 모달에서 adminViewedAt 보다 이 시각이 늦으면 행에 "신규 사진" 배지 표시.
    @Column
    private LocalDateTime evidenceLastUploadedAt;

    // [DEPRECATED — 2026-05-06 per-worker 모델로 전환] 옛 claim 모델 시절 단일 완료자 컬럼.
    // 새 로직은 worker_completions 테이블(아래 OneToMany) 만 사용. 컬럼은 운영 데이터 보존
    // 차원에서 entity 에 유지하되 new code 에서는 read/write 안 함. 다음 메이저 정리 때 drop 예정.
    @Column(length = 50)
    private String workerCompletedBy;

    @Column
    private LocalDateTime workerCompletedAt;

    // 모바일 [작업완료] 신고 — 한 지시서를 여러 직원이 각자 따로 누름. 같은 슬롯 동료도 본인이
    // 따로 누를 때까지 자기 리스트엔 그대로 보임(per-worker independent). 작업현황 탭은 이
    // 컬렉션을 row 별로 펼쳐 직원별 카드로 보여준다.
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @Builder.Default
    private List<WorkerCompletion> workerCompletions = new ArrayList<>();

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

    // 휴지통에서 영구삭제(관리자 수동) 또는 30일 경과 자동삭제 시 찍힌다.
    // 의미: R2 의 도안 원본·미리보기·지시서 PDF·order_files 행은 모두 삭제됐고,
    // 현장 프로그램이 옛 지시서를 다시 찾는 데 필요한 최소 정보(거래처·제목·발주일·납기·
    // 사양메모·originalPdfFilename)만 남긴 "아카이브" 레코드라는 표시.
    // deletedAt != null && purgedAt == null  → 휴지통(파일 살아있음, 복원 가능)
    // purgedAt != null                       → 아카이브(파일 없음, 검색 전용)
    // 이 레코드 자체는 관리자가 아카이브 탭에서 [완전삭제] 해야 비로소 행이 사라진다.
    @Column
    private LocalDateTime purgedAt;

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
        LOCAL_CARGO,
        // 배송 방법을 아직 결정하지 않은 상태 — 워처 인쇄 다이얼로그에서 선택 가능.
        // 나중에 결정되면 어드민에서 다시 변경.
        TBD
    }
}
