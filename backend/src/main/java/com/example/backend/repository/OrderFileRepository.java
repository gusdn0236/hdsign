package com.example.backend.repository;

import com.example.backend.entity.OrderFile;
import com.example.backend.entity.Order;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface OrderFileRepository extends JpaRepository<OrderFile, Long> {
    List<OrderFile> findByOrder(Order order);

    /**
     * 관리자 증거사진 목록 — 거래처명 부분일치 검색 + 페이지네이션.
     * JOIN FETCH 로 order/client lazy proxy 미리 풀어둠 (DTO 직렬화 시점에 추가 쿼리 안 나도록).
     * q 가 null/blank 면 전체 반환.
     */
    @Query(value = """
            SELECT f FROM OrderFile f
            JOIN FETCH f.order o
            JOIN FETCH o.client c
            WHERE f.isEvidence = true
              AND (:q IS NULL OR LOWER(c.companyName) LIKE LOWER(CONCAT('%', :q, '%')))
            ORDER BY f.createdAt DESC
            """,
            countQuery = """
            SELECT COUNT(f) FROM OrderFile f
            WHERE f.isEvidence = true
              AND (:q IS NULL OR LOWER(f.order.client.companyName) LIKE LOWER(CONCAT('%', :q, '%')))
            """)
    Page<OrderFile> findEvidence(
            @Param("q") String q,
            Pageable pageable);

    /**
     * 작업자 이름 필터를 추가한 버전. workers 가 null/비어있으면 호출하지 말 것 — 빈 IN 절은 JPQL 에서 에러.
     */
    @Query(value = """
            SELECT f FROM OrderFile f
            JOIN FETCH f.order o
            JOIN FETCH o.client c
            WHERE f.isEvidence = true
              AND (:q IS NULL OR LOWER(c.companyName) LIKE LOWER(CONCAT('%', :q, '%')))
              AND f.uploadedDepartment IN :workers
            ORDER BY f.createdAt DESC
            """,
            countQuery = """
            SELECT COUNT(f) FROM OrderFile f
            WHERE f.isEvidence = true
              AND (:q IS NULL OR LOWER(f.order.client.companyName) LIKE LOWER(CONCAT('%', :q, '%')))
              AND f.uploadedDepartment IN :workers
            """)
    Page<OrderFile> findEvidenceByWorkers(
            @Param("q") String q,
            @Param("workers") List<String> workers,
            Pageable pageable);
}
