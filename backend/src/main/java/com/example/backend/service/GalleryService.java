package com.example.backend.service;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.entity.GalleryImage;
import com.example.backend.repository.GalleryImageRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import java.io.IOException;
import java.nio.file.*;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class GalleryService {

    private final GalleryImageRepository galleryImageRepository;

    @Value("${upload.dir:uploads}")
    private String uploadDir;

    public List<GalleryImageDto> getImages(String category) {
        return galleryImageRepository
            .findByCategoryOrderByCreatedAtDesc(category)
            .stream()
            .map(GalleryImageDto::from)
            .collect(Collectors.toList());
    }

    public List<GalleryImageDto> uploadImages(
        String category,
        String subCategory,
        List<MultipartFile> files
    ) throws IOException {

        Path dirPath = Paths.get(uploadDir, category);
        Files.createDirectories(dirPath);

        List<GalleryImageDto> results = new ArrayList<>();

        for (MultipartFile file : files) {
            if (file.isEmpty()) continue;

            String originalFilename = file.getOriginalFilename();
            String ext = "";
            if (originalFilename != null && originalFilename.contains(".")) {
                ext = originalFilename.substring(originalFilename.lastIndexOf("."));
            }

            String savedFilename = UUID.randomUUID() + ext;
            Path filePath = dirPath.resolve(savedFilename);
            Files.copy(file.getInputStream(), filePath, StandardCopyOption.REPLACE_EXISTING);

            GalleryImage image = GalleryImage.builder()
                .category(category)
                .subCategory(subCategory)
                .imageUrl(category + "/" + savedFilename)
                .originalName(originalFilename)
                .build();

            results.add(GalleryImageDto.from(galleryImageRepository.save(image)));
        }

        return results;
    }

    public void deleteImage(Long id) throws IOException {
        GalleryImage image = galleryImageRepository.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("이미지를 찾을 수 없습니다."));

        Path filePath = Paths.get(uploadDir, image.getImageUrl());
        Files.deleteIfExists(filePath);

        galleryImageRepository.delete(image);
    }
}