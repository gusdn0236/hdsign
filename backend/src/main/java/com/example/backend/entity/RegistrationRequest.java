package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import java.time.LocalDateTime;

@Entity
@Table(name = "registration_requests")
@Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
public class RegistrationRequest {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String email;

    @Column(nullable = false, length = 100)
    private String companyName;

    @Column(nullable = false, length = 50)
    private String contactName;

    @Column(nullable = false, length = 20)
    private String phone;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private RequestStatus status = RequestStatus.PENDING;

    private LocalDateTime processedAt;

    @CreationTimestamp
    private LocalDateTime createdAt;

    public enum RequestStatus {
        PENDING, APPROVED, REJECTED
    }
}
