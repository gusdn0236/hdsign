package com.example.backend.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.LocalDateTime;

// 지시서 변경 웹푸시 구독 1건 = 기기(브라우저) 1개.
// endpoint 가 사실상의 기기 식별자 — 같은 기기가 다시 구독하면 endpoint 로 upsert.
@Entity
@Table(name = "push_subscriptions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PushSubscription {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 500)
    private String endpoint;

    @Column(nullable = false)
    private String p256dh;

    @Column(nullable = false)
    private String auth;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private Mode mode;

    // mode = MINE 일 때만 값이 있음. workers.js 의 직원 이름 문자열과 동일해야 매칭됨.
    @Column(length = 64)
    private String worker;

    @Column(nullable = false)
    private LocalDateTime createdAt;

    // 마지막으로 실제 발송에 성공한 시각. null 이면 한 번도 성공한 적 없음.
    // PushSubscriptionCleanupScheduler 가 이 값으로 "오래 죽어있는 구독"을 판별한다.
    @Column
    private LocalDateTime lastSuccessAt;

    public enum Mode {
        ALL, MINE
        // OFF 는 별도 상태로 저장하지 않고 구독 row 자체를 삭제한다(= 발송 대상에서 자동 제외).
    }
}
