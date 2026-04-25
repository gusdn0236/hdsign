package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import java.time.LocalDateTime;

@Entity
@Table(name = "order_files")
@Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
public class OrderFile {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @Column(nullable = false, length = 255)
    private String originalName;  // 사용자 업로드 원본 파일명

    @Column(nullable = false, length = 255)
    private String storedName;    // R2 저장 키 (UUID 기반)

    @Column(nullable = false, length = 500)
    private String fileUrl;       // R2 공개 접근 URL

    @Column(length = 500)
    private String previewUrl;    // 미리보기용 이미지 URL (AI/PDF 변환 썸네일)

    @Column(nullable = false)
    private Long fileSize;        // 바이트 단위

    @Column(length = 100)
    private String contentType;   // image/jpeg, application/pdf 등

    @Column(nullable = false)
    @Builder.Default
    private Boolean isEvidence = false;   // QR 카메라 업로드로 들어온 증거 사진

    @Column(length = 100)
    private String uploadedDepartment;    // 증거 사진을 올린 부서 (휴대폰 localStorage 기준)

    @CreationTimestamp
    private LocalDateTime createdAt;
}
