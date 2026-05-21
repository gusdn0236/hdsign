package com.example.backend.service;

import com.example.backend.dto.RateItemDto;
import com.example.backend.entity.RateItem;
import com.example.backend.repository.RateItemRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 단가 마스터 CRUD. 공정 기반 견적의 원가 기준 데이터를 관리한다.
 */
@Service
@RequiredArgsConstructor
public class RateItemService {

    private final RateItemRepository rateItemRepository;

    @Transactional(readOnly = true)
    public List<RateItemDto> list() {
        return rateItemRepository.findAllByOrderByRateTypeAscCategoryAscNameAsc()
                .stream().map(RateItemDto::from).toList();
    }

    @Transactional
    public RateItemDto create(RateItemDto dto) {
        RateItem item = new RateItem();
        apply(item, dto);
        return RateItemDto.from(rateItemRepository.save(item));
    }

    @Transactional
    public RateItemDto update(Long id, RateItemDto dto) {
        RateItem item = rateItemRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("단가 항목을 찾을 수 없습니다."));
        apply(item, dto);
        return RateItemDto.from(rateItemRepository.save(item));
    }

    @Transactional
    public void delete(Long id) {
        rateItemRepository.deleteById(id);
    }

    private void apply(RateItem item, RateItemDto dto) {
        if (dto.getName() == null || dto.getName().isBlank()) {
            throw new IllegalArgumentException("항목명을 입력해주세요.");
        }
        item.setRateType(parseType(dto.getRateType()));
        item.setName(dto.getName().trim());
        item.setSpec(blankToNull(dto.getSpec()));
        item.setVendor(blankToNull(dto.getVendor()));
        item.setUnit(blankToNull(dto.getUnit()));
        item.setUnitPrice(dto.getUnitPrice() != null ? Math.max(0L, dto.getUnitPrice()) : 0L);
        item.setCategory(blankToNull(dto.getCategory()));
        item.setNote(dto.getNote());
        item.setActive(dto.getActive() == null ? Boolean.TRUE : dto.getActive());
    }

    private static RateItem.RateType parseType(String s) {
        if (s == null || s.isBlank()) return RateItem.RateType.MATERIAL;
        try {
            return RateItem.RateType.valueOf(s.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return RateItem.RateType.MATERIAL;
        }
    }

    private static String blankToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
