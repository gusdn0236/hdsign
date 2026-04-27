package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import java.time.LocalDateTime;

@Entity
@Table(name = "client_users")
@Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
public class ClientUser {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // 가입 대기(PENDING_SIGNUP) 상태에서는 비어있다. 거래처가 가입 신청 시 채워진다.
    // UNIQUE 인덱스가 있지만 MySQL 은 NULL 다중 허용이라 빈 값 여러 행이 공존 가능.
    @Column(unique = true, length = 50)
    private String username;

    // 가입 대기 상태에서는 빈 placeholder. ACTIVE 전환 시 BCrypt 해시로 채워진다.
    @Column
    private String password;

    @Column(nullable = false, length = 100)
    private String companyName;   // 업체명 (올리브영, 스타벅스 등)

    // 네트워크 거래처 폴더명. 워처가 \\Main\...\거래처\<networkFolderName> 으로 정확일치 매칭한다.
    // 비어있으면 워처가 companyName 으로 폴백 매칭.
    @Column(length = 100)
    private String networkFolderName;

    @Column(length = 50)
    private String contactName;   // 담당자 이름

    @Column(length = 20)
    private String phone;         // 담당자 연락처

    @Column(unique = true, length = 100)
    private String email;         // 담당자 이메일

    @Column(nullable = false)
    @Builder.Default
    private Boolean isActive = true;  // false면 로그인 차단 (status 와 동기화 유지)

    // 가입 단계: PENDING_SIGNUP / PENDING_APPROVAL / ACTIVE / DISABLED
    // 로그인 가능은 ACTIVE 만. status 는 isActive 보다 세밀한 단계 — 메시지 차별화 목적.
    @Column(nullable = false, length = 30)
    @Builder.Default
    private String status = "ACTIVE";

    // 자동생성된 임시 비번을 평문으로 보관. 분실 문의 시 관리자가 다시 알려주기 위함.
    // 평문 유출의 위험 한계: (1) 거래처가 평소 비번을 정하지 못함 → 다른 사이트 비번과 무관
    //   (2) 본 사이트 한정 무단 접근만 가능 → BCrypt 깨뜨린 것과 동일 위협 수준.
    // 거래처가 자기 비번을 직접 변경하는 기능은 없다. 변경은 관리자 [재발급] 버튼만.
    @Column(length = 50)
    private String passwordPlaintext;

    private LocalDateTime signupRequestedAt;

    @CreationTimestamp
    private LocalDateTime createdAt;
}
