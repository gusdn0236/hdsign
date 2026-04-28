package com.example.backend.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import java.time.LocalDateTime;

@Entity
@Table(
        name = "gallery_images",
        indexes = {
                // category 별 최신 정렬 조회(GalleryService.getImages) 가속.
                // 한 카테고리에 수백 장이 쌓여도 풀스캔 없이 인덱스 + reverse scan 으로 정렬 응답.
                @Index(name = "idx_gallery_cat_created", columnList = "category, createdAt")
        }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class GalleryImage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 50)
    private String category;

    @Column(length = 50)
    private String subCategory;

    @Column(nullable = false)
    private String imageUrl;

    @Column(length = 255)
    private String originalName;

    @CreationTimestamp
    private LocalDateTime createdAt;
}
