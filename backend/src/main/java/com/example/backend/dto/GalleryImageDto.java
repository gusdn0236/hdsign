package com.example.backend.dto;

import com.example.backend.entity.GalleryImage;
import lombok.Data;
import java.time.LocalDateTime;

@Data
public class GalleryImageDto {
    private Long id;
    private String category;
    private String subCategory;
    private String imageUrl;
    private String originalName;
    private LocalDateTime createdAt;

    public static GalleryImageDto from(GalleryImage img) {
        GalleryImageDto dto = new GalleryImageDto();
        dto.setId(img.getId());
        dto.setCategory(img.getCategory());
        dto.setSubCategory(img.getSubCategory());
        dto.setImageUrl(img.getImageUrl());
        dto.setOriginalName(img.getOriginalName());
        dto.setCreatedAt(img.getCreatedAt());
        return dto;
    }
}
