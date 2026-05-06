package com.example.backend.repository;

import com.example.backend.entity.Order;
import com.example.backend.entity.ClientUser;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

public interface OrderRepository extends JpaRepository<Order, Long> {
    // OrderDto.toResponse() 가 client.companyName + files 목록을 모두 직렬화하므로
    // EntityGraph 로 한 쿼리에 같이 끌어와 N+1 제거. 주문이 누적될수록 효과 큼.
    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByClientAndDeletedAtIsNullOrderByCreatedAtDesc(ClientUser client);

    Optional<Order> findByOrderNumber(String orderNumber);

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNullOrderByCreatedAtDesc();

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNotNullOrderByDeletedAtDesc();

    List<Order> findByDeletedAtBefore(LocalDateTime cutoff);
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
