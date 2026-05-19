package com.example.backend.repository;

import com.example.backend.entity.OrderFile;
import com.example.backend.entity.Order;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDateTime;
import java.util.List;

public interface OrderFileRepository extends JpaRepository<OrderFile, Long> {
    List<OrderFile> findByOrder(Order order);

    /**
     * 관리자 증거사진 목록 — 거래처/기간 필터 + 페이지네이션.
     * JOIN FETCH 로 order/client lazy proxy 미리 풀어둠 (DTO 직렬화 시점에 추가 쿼리 안 나도록).
     * 모든 필터 파라미터는 null 허용 — null 이면 해당 조건 무시.
     */
    @Query(value = """
            SELECT f FROM OrderFile f
            JOIN FETCH f.order o
            JOIN FETCH o.client c
            WHERE f.isEvidence = true
              AND (:clientId IS NULL OR c.id = :clientId)
              AND (:from IS NULL OR f.createdAt >= :from)
              AND (:to IS NULL OR f.createdAt < :to)
            ORDER BY f.createdAt DESC
            """,
            countQuery = """
            SELECT COUNT(f) FROM OrderFile f
            WHERE f.isEvidence = true
              AND (:clientId IS NULL OR f.order.client.id = :clientId)
              AND (:from IS NULL OR f.createdAt >= :from)
              AND (:to IS NULL OR f.createdAt < :to)
            """)
    Page<OrderFile> findEvidence(
            @Param("clientId") Long clientId,
            @Param("from") LocalDateTime from,
            @Param("to") LocalDateTime to,
            Pageable pageable);
}
