package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

/**
 * 작업 사례에 첨부한 파일 — 거래처 원본 AI 파일, 사장님 가격 결정 이미지, 도면 등.
 * 사례 하나가 사람의 "작업 폴더"처럼 완결되게 한다. R2 에 저장(OrderFile 과 같은 패턴).
 */
@Entity
@Table(name = "job_case_files")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class JobCaseFile {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "job_case_id", nullable = false)
    private JobCase jobCase;

    // 첨부 종류 — AI_SOURCE(거래처 AI 원본), PRICE(가격 결정 이미지), REFERENCE(도면·기타 참고).
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private FileKind kind = FileKind.REFERENCE;

    @Column(length = 255)
    private String originalName;

    // R2 저장 객체 키.
    @Column(nullable = false, length = 255)
    private String storedName;

    @Column(nullable = false, length = 500)
    private String fileUrl;

    @Column
    private Long fileSize;

    @Column(length = 100)
    private String contentType;

    @Column(nullable = false)
    @Builder.Default
    private Integer sortOrder = 0;

    @CreationTimestamp
    private LocalDateTime createdAt;

    public enum FileKind {
        AI_SOURCE,   // 거래처가 보낸 원본 AI 파일
        PRICE,       // 사장님 가격 결정 이미지(메모·캡쳐)
        REFERENCE    // 도면·기타 참고
    }
}
