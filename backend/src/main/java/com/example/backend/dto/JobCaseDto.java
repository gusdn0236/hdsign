package com.example.backend.dto;

import com.example.backend.entity.JobCase;
import com.example.backend.entity.JobCaseCost;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 작업 사례 API 입출력 DTO. 모두 @Data 라 Jackson 직렬화/역직렬화 둘 다 된다.
 */
public class JobCaseDto {

    /** 명시적 비용 한 줄. */
    @Data
    public static class Cost {
        private Long id;
        private Integer sortOrder;
        private String label;
        private Long amount;
    }

    /** 작업 사례 저장 요청 — 생성·수정 공용. */
    @Data
    public static class SaveRequest {
        private String title;
        private Long clientId;
        private String clientName;
        private String description;
        private String sizeText;
        private String material;
        private Long finalPrice;
        private String jobDate;     // yyyy-MM-dd
        private String note;
        private List<Cost> costs;
    }

    /** 작업 사례 응답. */
    @Data
    public static class Response {
        private Long id;
        private String title;
        private Long clientId;
        private String clientName;
        private String description;
        private String sizeText;
        private String material;
        private Long finalPrice;
        private LocalDate jobDate;
        private String note;
        private List<Cost> costs;
        private Long knownCostTotal;   // 명시적 비용 합
        private Long processCost;      // 무형 공정 비용(잔차) = finalPrice − knownCostTotal
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
    }

    public static Response toResponse(JobCase c) {
        Response r = new Response();
        r.setId(c.getId());
        r.setTitle(c.getTitle());
        r.setClientId(c.getClient() != null ? c.getClient().getId() : null);
        r.setClientName(c.getClientName());
        r.setDescription(c.getDescription());
        r.setSizeText(c.getSizeText());
        r.setMaterial(c.getMaterial());
        long finalPrice = c.getFinalPrice() != null ? c.getFinalPrice() : 0L;
        r.setFinalPrice(finalPrice);
        r.setJobDate(c.getJobDate());
        r.setNote(c.getNote());
        List<Cost> costs = c.getCosts().stream().map(JobCaseDto::toCost).toList();
        r.setCosts(costs);
        long known = costs.stream().mapToLong(x -> x.getAmount() != null ? x.getAmount() : 0L).sum();
        r.setKnownCostTotal(known);
        r.setProcessCost(finalPrice - known);
        r.setCreatedAt(c.getCreatedAt());
        r.setUpdatedAt(c.getUpdatedAt());
        return r;
    }

    private static Cost toCost(JobCaseCost c) {
        Cost d = new Cost();
        d.setId(c.getId());
        d.setSortOrder(c.getSortOrder());
        d.setLabel(c.getLabel());
        d.setAmount(c.getAmount());
        return d;
    }
}
