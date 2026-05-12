package com.example.backend.repository;

import com.example.backend.entity.Order;
import com.example.backend.entity.ClientUser;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

public interface OrderRepository extends JpaRepository<Order, Long> {
    // OrderDto.toResponse() 가 client.companyName + files 목록을 모두 직렬화하므로
    // EntityGraph 로 한 쿼리에 같이 끌어와 N+1 제거. 주문이 누적될수록 효과 큼.
    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByClientAndDeletedAtIsNullOrderByCreatedAtDesc(ClientUser client);

    // 거래처 삭제 가능 여부 판단용 — soft-delete 된 주문도 client_id FK 가 살아있어 포함해서 센다.
    long countByClient(ClientUser client);

    // 거래처 통합 시 client_id 재지정용 — soft-delete 포함 전체.
    List<Order> findByClient(ClientUser client);

    Optional<Order> findByOrderNumber(String orderNumber);

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNullOrderByCreatedAtDesc();

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNotNullOrderByDeletedAtDesc();

    // 휴지통(파일 살아있음, 복원 가능) — 아카이브로 넘어간 건(purgedAt != null)은 제외.
    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNotNullAndPurgedAtIsNullOrderByDeletedAtDesc();

    // 아카이브 목록 — 파일은 이미 영구삭제됐고 최소 레코드만 남은 건. 관리자 [완전삭제] 대상.
    @EntityGraph(attributePaths = {"client"})
    List<Order> findByPurgedAtIsNotNullOrderByPurgedAtDesc();

    // 30일 자동 아카이브 스케줄러용 — 이미 아카이브된 건(purgedAt != null)은 다시 안 건드림.
    List<Order> findByDeletedAtBeforeAndPurgedAtIsNull(LocalDateTime cutoff);

    // 현장 프로그램 "옛 지시서 찾기" — 거래처명 / 발주일(생성일) / 원본 PDF 파일명으로 검색.
    // 살아있는 건·휴지통·아카이브 모두 포함(아카이브된 옛 건이 핵심 타깃). null 파라미터는 무시.
    @EntityGraph(attributePaths = {"client"})
    @Query("""
            SELECT o FROM Order o LEFT JOIN o.client c
             WHERE (:company  IS NULL OR LOWER(c.companyName)         LIKE LOWER(CONCAT('%', :company,  '%')))
               AND (:filename IS NULL OR LOWER(o.originalPdfFilename) LIKE LOWER(CONCAT('%', :filename, '%')))
               AND (:from     IS NULL OR o.createdAt >= :from)
               AND (:to       IS NULL OR o.createdAt <  :to)
             ORDER BY o.createdAt DESC
            """)
    List<Order> searchForFieldArchive(@Param("company") String company,
                                      @Param("filename") String filename,
                                      @Param("from") LocalDateTime from,
                                      @Param("to") LocalDateTime to,
                                      Pageable pageable);
    // 발주번호 채번에 사용 — count(11) + 1 = 12 라도 중간에 삭제로 빈 슬롯이 생기면
    // 이미 -12 가 존재해 unique 충돌이 났다(2026-05-06). MAX(suffix) + 1 로 바꾸기 위해
    // 같은 prefix 의 모든 번호를 가져와 Java 에서 max 계산. 하루 최대 ~수십 건이라 비용 미미.
    List<Order> findByOrderNumberStartingWith(String prefix);

    // 백필 — worksheetPdfUrl 은 있는데 worksheetThumbnailUrl 이 비어있는 주문.
    // admin POST /backfill-worksheet-thumbnails 에서 페이지 단위로 처리.
    List<Order> findByWorksheetPdfUrlIsNotNullAndWorksheetThumbnailUrlIsNullOrderByCreatedAtDesc(
            org.springframework.data.domain.Pageable pageable);

    long countByWorksheetPdfUrlIsNotNullAndWorksheetThumbnailUrlIsNull();

    // 백필 — worksheetPdfUrl 이 있는 활성 주문 전체. admin POST /backfill-worksheet-flatten
    // 에서 페이지 단위로 처리해 기존 PDF 를 단일 이미지/페이지 구조로 재저장한다.
    // "이미 평탄화됨" 마커 컬럼은 두지 않음 — 재처리해도 시각적 결과 동일하고 비용 미미.
    List<Order> findByWorksheetPdfUrlIsNotNullAndDeletedAtIsNullOrderByCreatedAtDesc(
            org.springframework.data.domain.Pageable pageable);

    long countByWorksheetPdfUrlIsNotNullAndDeletedAtIsNull();
}
