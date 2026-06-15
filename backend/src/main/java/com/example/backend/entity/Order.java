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

    // worksheetPdfUrl 이 가리키는 PDF 의 바이트 크기. 발주관리/카드에 작게 표시해 비정상 대용량
    // (예: 압축 안 된 사진으로 수십~수백 MB) 업로드를 한눈에 식별 — 업로드 실패 원인 추적용.
    private Long worksheetPdfSize;

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

    // 워처가 인쇄 시점에 확정한 지시서 .fs 파일의 전체 경로
    // (예: "\\Main\현대공유\...\싸인월드\05-14AIGLE 고무\2단고무.아크릴.fs").
    // 현장 뷰어 [FS에서 열기] 가 이 경로로 .fs 를 곧장 연다 — 파일명 추측/시각값 폴백/퍼지매칭
    // 불필요. 한 폴더에 .fs 가 여러 개여도 지시서마다 자기 파일을 못 박아 둬 안 헷갈린다.
    // 비어 있으면(옛 지시서 / 워처가 경로 확정 실패) originalPdfFilename 매칭으로 폴백.
    @Column(length = 500)
    private String originalFsPath;

    // 워처가 인쇄(웹반영) 시점에 그 .fs 에 새로 발급해 박은 전역 고유 ID(uuid hex, 32자).
    // 같은 값을 .fs 의 NTFS ADS(hdsign.fsuid)에도 기록 → 현장 뷰어 [FS에서 열기] 가 이 UID 로
    // 거래처 폴더의 .fs 를 찾아 연다. 파일명을 바꾸거나 폴더 안에서 옮겨도 ADS 가 따라다녀
    // 정확히 매칭된다(이름 추측/시각값 폴백 불필요). 주문번호와 독립 — 주문을 지우고 다시
    // 만들어도 인쇄 때마다 새 UID 가 발급돼 옛 스탬프와 충돌하지 않는다. 인쇄마다 갱신.
    @Column(length = 64)
    private String originalFsUid;

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

    // 지시서 PDF가 웹에 '재반영'된 가장 최근 시각. 첫 등록(최초 부착)은 제외하고
    // 두 번째 업로드부터 기록한다 — 값이 있으면 "한 번 이상 다시 올라온 지시서".
    // 변경 메모 입력 여부와 무관하며, 한 번 찍히면 재인쇄/열람으로도 비우지 않으므로
    // 관리자 카드의 '변경' 배지를 영구 유지하는 신호로 쓴다(사진 배지의
    // evidenceLastUploadedAt 와 같은 역할).
    @Column
    private LocalDateTime worksheetRevisedAt;

    // 관리자가 마지막으로 모달을 열어 본 시각. 위 두 시각보다 늦으면 배지가 사라진다.
    @Column
    private LocalDateTime adminViewedAt;

    @CreationTimestamp
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    @Column
    private LocalDateTime deletedAt;

    // [DEPRECATED — 2026-05-14 아카이브 흐름 폐기] 옛 "아카이브"(파일은 영구삭제됐지만 최소 레코드만
    // 남긴 상태) 표시 컬럼. 신규 코드에서는 더 이상 쓰지 않으며, 작업완료(deletedAt) 30일 경과 시
    // R2 파일 + Order 행을 같이 하드 삭제한다. DB 호환을 위해 컬럼만 남겨두며, 옛 archived 행이
    // 남아 있어도 스케줄러가 다음 run 에서 함께 하드 삭제한다.
    @Column
    private LocalDateTime purgedAt;

    // ===== 명세서 작성 잠금(소프트 락) — 동시 중복작성 방지 =====
    // 명세서 모달을 연 관리자의 username(소유권 식별). 모달 닫으면 비운다.
    @Column(length = 100)
    private String statementEditingBy;
    // 화면에 띄울 표시 이름 스냅샷("ㅇㅇㅇ님이 작성중"). 잠금 획득 시점의 admin.name.
    @Column(length = 100)
    private String statementEditingName;
    // 마지막 하트비트 시각. 일정 시간(TTL) 지나면 stale 로 보고 무시 — 탭을 그냥 닫아도 자동 만료.
    @Column
    private LocalDateTime statementEditingAt;

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
