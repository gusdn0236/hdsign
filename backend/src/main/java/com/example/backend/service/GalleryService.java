package com.example.backend.service;

import com.example.backend.dto.GalleryImageDto;
import com.example.backend.entity.GalleryImage;
import com.example.backend.repository.GalleryImageRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class GalleryService {

    private final GalleryImageRepository galleryImageRepository;

    @Value("${r2.access-key}")
    private String accessKey;

    @Value("${r2.secret-key}")
    private String secretKey;

    @Value("${r2.endpoint}")
    private String endpoint;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    private S3Client getS3Client() {
        return S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKey, secretKey)))
                .region(Region.of("auto"))
                .build();
    }

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
        S3Client s3 = getS3Client();
        List<GalleryImageDto> results = new ArrayList<>();

        for (MultipartFile file : files) {
            if (file.isEmpty()) continue;

            String originalFilename = file.getOriginalFilename();
            String ext = "";
            if (originalFilename != null && originalFilename.contains(".")) {
                ext = originalFilename.substring(originalFilename.lastIndexOf("."));
            }

            String savedFilename = category + "/" + UUID.randomUUID() + ext;

            PutObjectRequest putRequest = PutObjectRequest.builder()
                    .bucket(bucket)
                    .key(savedFilename)
                    .contentType(file.getContentType())
                    .build();

            s3.putObject(putRequest, RequestBody.fromBytes(file.getBytes()));

            String imageUrl = publicUrl + "/" + savedFilename;

            GalleryImage image = GalleryImage.builder()
                    .category(category)
                    .subCategory(subCategory)
                    .imageUrl(imageUrl)
                    .originalName(originalFilename)
                    .build();

            results.add(GalleryImageDto.from(galleryImageRepository.save(image)));
        }
        return results;
    }

    public void deleteImage(Long id) throws IOException {
        GalleryImage image = galleryImageRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("이미지를 찾을 수 없습니다."));

        S3Client s3 = getS3Client();
        String key = image.getImageUrl().replace(publicUrl + "/", "");

        s3.deleteObject(DeleteObjectRequest.builder()
                .bucket(bucket)
                .key(key)
                .build());

        galleryImageRepository.delete(image);
    }
}