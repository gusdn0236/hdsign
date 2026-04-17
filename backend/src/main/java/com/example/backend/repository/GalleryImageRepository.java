package com.example.backend.repository;

import com.example.backend.entity.GalleryImage;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface GalleryImageRepository extends JpaRepository<GalleryImage, Long> {
    List<GalleryImage> findByCategoryOrderByCreatedAtDesc(String category);
    List<GalleryImage> findByCategoryAndSubCategoryOrderByCreatedAtDesc(String category, String subCategory);
}
