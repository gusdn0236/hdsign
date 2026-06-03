package com.example.backend.repository;

import com.example.backend.entity.AutoQuoteEstimate;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface AutoQuoteEstimateRepository extends JpaRepository<AutoQuoteEstimate, Long> {

    // 주문당 명세서 1건(upsert/조회).
    Optional<AutoQuoteEstimate> findByOrderId(Long orderId);

    // 주문 목록 응답에 명세서/이지폼 배지 플래그를 채울 때 — 목록의 order_id 들을 한 쿼리로
    // 끌어와 N+1 회피(주문이 누적될수록 효과 큼).
    List<AutoQuoteEstimate> findByOrderIdIn(Collection<Long> orderIds);
}
