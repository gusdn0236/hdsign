package com.example.backend.repository;

import com.example.backend.entity.PushSubscription;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

public interface PushSubscriptionRepository extends JpaRepository<PushSubscription, Long> {
    Optional<PushSubscription> findByEndpoint(String endpoint);

    // 파생 delete 쿼리는 SimpleJpaRepository 의 기본 CRUD 와 달리 트랜잭션이 자동으로 붙지 않는다.
    // 없으면 "알림 끄기" 호출이 TransactionRequiredException 으로 500 나고 구독 row 가 그대로 남는다.
    @Transactional
    void deleteByEndpoint(String endpoint);

    // 지시서 변경 시 전체 발송 대상 조회 — ALL 구독자 + MINE 구독자(슬롯 매칭은 서비스단에서 필터).
    List<PushSubscription> findByMode(PushSubscription.Mode mode);

    List<PushSubscription> findAll();

    // 정리 배치용 — 구독한 지 오래됐는데 단 한 번도 발송에 성공한 적 없는 구독.
    List<PushSubscription> findByCreatedAtBeforeAndLastSuccessAtIsNull(LocalDateTime cutoff);
}
