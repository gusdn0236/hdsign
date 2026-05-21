package com.example.backend.service;

import com.example.backend.dto.JobCaseDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.JobCase;
import com.example.backend.entity.JobCaseCost;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.JobCaseRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;

/**
 * 작업 사례 CRUD. 무형 공정 비용(잔차)은 응답 DTO 에서 최종가 − 명시적 비용 합으로 계산한다.
 */
@Service
@RequiredArgsConstructor
public class JobCaseService {

    private final JobCaseRepository jobCaseRepository;
    private final ClientUserRepository clientUserRepository;

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
        jobCaseRepository.delete(find(id));
    }

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
