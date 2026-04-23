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

    @Column(nullable = false, unique = true, length = 50)
    private String username;

    @Column(nullable = false)
    private String password;

    @Column(nullable = false, length = 100)
    private String companyName;   // 업체명 (올리브영, 스타벅스 등)

    @Column(length = 50)
    private String contactName;   // 담당자 이름

    @Column(length = 20)
    private String phone;         // 담당자 연락처

    @Column(unique = true, length = 100)
    private String email;         // 담당자 이메일

    @Column(nullable = false)
    @Builder.Default
    private Boolean isActive = true;  // false면 로그인 차단

    @CreationTimestamp
    private LocalDateTime createdAt;
}
