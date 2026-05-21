package com.example.backend.dto;

import com.example.backend.entity.RateItem;
import lombok.Data;

/**
 * 단가 마스터 항목 DTO — 요청·응답 공용. 모두 @Data 라 Jackson 직렬화/역직렬화 둘 다 된다.
 */
@Data
public class RateItemDto {
    private Long id;
    private String rateType;   // MATERIAL / LABOR / OUTSOURCE / EXTRA
    private String name;
    private String spec;
    private String vendor;
    private String unit;
    private Long unitPrice;
    private String category;
    private String note;
    private Boolean active;

    public static RateItemDto from(RateItem r) {
        RateItemDto d = new RateItemDto();
        d.setId(r.getId());
        d.setRateType(r.getRateType() != null ? r.getRateType().name() : null);
        d.setName(r.getName());
        d.setSpec(r.getSpec());
        d.setVendor(r.getVendor());
        d.setUnit(r.getUnit());
        d.setUnitPrice(r.getUnitPrice());
        d.setCategory(r.getCategory());
        d.setNote(r.getNote());
        d.setActive(r.getActive());
        return d;
    }
}
