-- 푸시 구독의 마지막 발송 성공 시각. 오래도록 한 번도 도달하지 못한 구독을
-- 정리 배치(PushSubscriptionCleanupScheduler)가 걸러내는 기준이 된다.
-- NULL = 아직 한 번도 성공한 적 없음(방금 구독했거나, 계속 실패 중).
ALTER TABLE push_subscriptions ADD COLUMN last_success_at DATETIME NULL;
