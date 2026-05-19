package com.example.backend.service;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.entity.GalleryImage;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.GalleryImageRepository;
import com.example.backend.repository.OrderFileRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CopyObjectRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class GalleryService {

    private final GalleryImageRepository galleryImageRepository;
    private final OrderFileRepository orderFileRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")     private String bucket;
    @Value("${r2.public-url}") private String publicUrl;

    public List<GalleryImageDto> getImages(String category) {
        return galleryImageRepository
                .findByCategoryOrderByCreatedAtDesc(category)
                .stream()
                .map(GalleryImageDto::from)
                .collect(Collectors.toList());
    }

    public List<GalleryImageDto> uploadImages(
            String category, String subCategory, List<MultipartFile> files
    ) throws IOException {
        List<GalleryImageDto> results = new ArrayList<>();
        for (MultipartFile file : files) {
            if (file.isEmpty()) continue;
            String originalFilename = file.getOriginalFilename();
            String ext = (originalFilename != null && originalFilename.contains("."))
                    ? originalFilename.substring(originalFilename.lastIndexOf(".")) : "";
            String savedFilename = category + "/" + UUID.randomUUID() + ext;
            try (java.io.InputStream in = file.getInputStream()) {
                s3Client.putObject(
                        PutObjectRequest.builder().bucket(bucket).key(savedFilename)
                                .contentType(file.getContentType()).build(),
                        RequestBody.fromInputStream(in, file.getSize()));
            }
            String imageUrl = publicUrl + "/" + savedFilename;
            GalleryImage image = GalleryImage.builder()
                    .category(category).subCategory(subCategory)
                    .imageUrl(imageUrl).originalName(originalFilename).build();
            results.add(GalleryImageDto.from(galleryImageRepository.save(image)));
        }
        return results;
    }

    /**
     * 현장 증거사진(OrderFile)을 갤러리로 복사 등록. R2 서버 사이드 CopyObject 로 처리해
     * 다운로드/재업로드 없이 새 키에 사본을 만들고, gallery_images 행을 추가한다.
     * 원본 증거사진은 그대로 둔다 — 작업증거로서의 역할은 유지.
     */
    public GalleryImageDto addEvidenceToGallery(Long evidenceFileId, String category, String subCategory) {
        OrderFile src = orderFileRepository.findById(evidenceFileId)
                .orElseThrow(() -> new IllegalArgumentException("증거사진을 찾을 수 없습니다."));
        if (!Boolean.TRUE.equals(src.getIsEvidence())) {
            throw new IllegalArgumentException("증거사진(isEvidence=true) 만 갤러리로 등록할 수 있습니다.");
        }
        String srcKey = src.getStoredName();
        if (srcKey == null || srcKey.isBlank()) {
            throw new IllegalStateException("원본 R2 키가 비어있습니다.");
        }
        String origName = src.getOriginalName();
        String ext = (origName != null && origName.contains("."))
                ? origName.substring(origName.lastIndexOf(".")) : "";
        String destKey = category + "/" + UUID.randomUUID() + ext;

        s3Client.copyObject(CopyObjectRequest.builder()
                .sourceBucket(bucket).sourceKey(srcKey)
                .destinationBucket(bucket).destinationKey(destKey)
                .build());

        String imageUrl = publicUrl + "/" + destKey;
        GalleryImage image = GalleryImage.builder()
                .category(category)
                .subCategory(subCategory)
                .imageUrl(imageUrl)
                .originalName(origName)
                .build();
        return GalleryImageDto.from(galleryImageRepository.save(image));
    }

    public void deleteImage(Long id) throws IOException {
        GalleryImage image = galleryImageRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("이미지를 찾을 수 없습니다."));
        String key = image.getImageUrl().replace(publicUrl + "/", "");
        s3Client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
        galleryImageRepository.delete(image);
    }
}