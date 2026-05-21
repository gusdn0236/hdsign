package com.example.backend.service;

import com.example.backend.dto.JobCaseDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.JobCase;
import com.example.backend.entity.JobCaseCost;
import com.example.backend.entity.JobCaseFile;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.JobCaseRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * 작업 사례 CRUD + 첨부 파일(거래처 AI 원본·가격 결정 이미지·도면) 업로드.
 * 무형 공정 비용(잔차)은 응답 DTO 에서 최종가 − 명시적 비용 합으로 계산한다.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class JobCaseService {

    private final JobCaseRepository jobCaseRepository;
    private final ClientUserRepository clientUserRepository;
    private final S3Client s3Client;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    @Transactional(readOnly = true)
    public List<JobCaseDto.Response> list() {
        return jobCaseRepository.findAllByOrderByCreatedAtDesc()
                .stream().map(JobCaseDto::toResponse).toList();
    }

    @Transactional(readOnly = true)
    public JobCaseDto.Response get(Long id) {
        return JobCaseDto.toResponse(find(id));
    }

    @Transactional
    public JobCaseDto.Response create(JobCaseDto.SaveRequest req) {
        JobCase c = new JobCase();
        apply(c, req);
        return JobCaseDto.toResponse(jobCaseRepository.save(c));
    }

    @Transactional
    public JobCaseDto.Response update(Long id, JobCaseDto.SaveRequest req) {
        JobCase c = find(id);
        apply(c, req);
        return JobCaseDto.toResponse(jobCaseRepository.save(c));
    }

    @Transactional
    public void delete(Long id) {
        JobCase c = find(id);
        for (JobCaseFile f : c.getFiles()) {
            deleteFromR2(f.getStoredName());
        }
        jobCaseRepository.delete(c);
    }

    // ── 첨부 파일 ─────────────────────────────

    @Transactional
    public JobCaseDto.Response addFile(Long id, String kindRaw, MultipartFile file) {
        JobCase c = find(id);
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("파일이 비어있습니다.");
        }
        JobCaseFile.FileKind kind = parseKind(kindRaw);
        String contentType = file.getContentType();
        String key = "job-cases/" + c.getId() + "/" + UUID.randomUUID()
                + extensionOf(file.getOriginalFilename());
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (Exception e) {
            throw new RuntimeException("파일을 읽지 못했습니다: " + e.getMessage());
        }
        try {
            s3Client.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(key)
                            .contentType(contentType != null ? contentType : "application/octet-stream")
                            .build(),
                    software.amazon.awssdk.core.sync.RequestBody.fromBytes(bytes));
        } catch (Exception e) {
            log.warn("작업 사례 파일 업로드 실패 [{}]: {}", c.getId(), e.getMessage());
            throw new RuntimeException("파일 업로드에 실패했습니다.");
        }
        JobCaseFile jf = JobCaseFile.builder()
                .jobCase(c)
                .kind(kind)
                .originalName(file.getOriginalFilename())
                .storedName(key)
                .fileUrl(normalizedPublicUrl() + key)
                .fileSize(file.getSize())
                .contentType(contentType)
                .sortOrder(c.getFiles().size())
                .build();
        c.getFiles().add(jf);
        return JobCaseDto.toResponse(jobCaseRepository.save(c));
    }

    @Transactional
    public JobCaseDto.Response deleteFile(Long caseId, Long fileId) {
        JobCase c = find(caseId);
        c.getFiles().removeIf(f -> {
            boolean match = f.getId().equals(fileId);
            if (match) deleteFromR2(f.getStoredName());
            return match;
        });
        return JobCaseDto.toResponse(jobCaseRepository.save(c));
    }

    // ── 내부 ─────────────────────────────────

    private JobCase find(Long id) {
        return jobCaseRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("작업 사례를 찾을 수 없습니다."));
    }

    private void apply(JobCase c, JobCaseDto.SaveRequest req) {
        // 거래처 — 등록 거래처면 연결 + 회사명 스냅샷, 미등록이면 입력값만.
        if (req.getClientId() != null) {
            ClientUser client = clientUserRepository.findById(req.getClientId()).orElse(null);
            c.setClient(client);
            String typed = blankToNull(req.getClientName());
            c.setClientName(typed != null ? typed
                    : (client != null ? client.getCompanyName() : null));
        } else {
            c.setClient(null);
            c.setClientName(blankToNull(req.getClientName()));
        }
        c.setTitle(blankToNull(req.getTitle()));
        c.setDescription(req.getDescription());
        c.setSizeText(blankToNull(req.getSizeText()));
        c.setMaterial(blankToNull(req.getMaterial()));
        c.setFinalPrice(req.getFinalPrice() != null ? req.getFinalPrice() : 0L);
        c.setJobDate(parseDate(req.getJobDate()));
        c.setNote(req.getNote());

        // 명시적 비용 전체 교체. 라벨·금액 둘 다 빈 줄은 버린다.
        c.getCosts().clear();
        int order = 0;
        if (req.getCosts() != null) {
            for (JobCaseDto.Cost dto : req.getCosts()) {
                String label = blankToNull(dto.getLabel());
                long amount = dto.getAmount() != null ? dto.getAmount() : 0L;
                if (label == null && amount == 0L) continue;
                JobCaseCost cost = new JobCaseCost();
                cost.setJobCase(c);
                cost.setSortOrder(order++);
                cost.setLabel(label);
                cost.setAmount(amount);
                c.getCosts().add(cost);
            }
        }
    }

    private void deleteFromR2(String key) {
        if (key == null || key.isBlank()) return;
        try {
            s3Client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
        } catch (Exception e) {
            log.warn("작업 사례 파일 R2 삭제 실패 [{}]: {}", key, e.getMessage());
        }
    }

    private String normalizedPublicUrl() {
        if (publicUrl == null || publicUrl.isBlank()) return "";
        return publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
    }

    private static String extensionOf(String filename) {
        if (filename != null) {
            int dot = filename.lastIndexOf('.');
            if (dot >= 0 && dot < filename.length() - 1) {
                return filename.substring(dot).toLowerCase();
            }
        }
        return "";
    }

    private static JobCaseFile.FileKind parseKind(String s) {
        if (s == null || s.isBlank()) return JobCaseFile.FileKind.REFERENCE;
        try {
            return JobCaseFile.FileKind.valueOf(s.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return JobCaseFile.FileKind.REFERENCE;
        }
    }

    private static LocalDate parseDate(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return LocalDate.parse(s.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static String blankToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
