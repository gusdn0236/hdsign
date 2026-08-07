package com.example.backend.repository;

import com.example.backend.entity.PushSubscription;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface PushSubscriptionRepository extends JpaRepository<PushSubscription, Long> {
    Optional<PushSubscription> findByEndpoint(String endpoint);

    void deleteByEndpoint(String endpoint);

    // 지시서 변경 시 전체 발송 대상 조회 — ALL 구독자 + MINE 구독자(슬롯 매칭은 서비스단에서 필터).
    List<PushSubscription> findByMode(PushSubscription.Mode mode);

    List<PushSubscription> findAll();
}
