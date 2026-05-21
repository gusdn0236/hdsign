package com.example.backend.repository;

import com.example.backend.entity.RateItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface RateItemRepository extends JpaRepository<RateItem, Long> {

    // 단가 마스터 화면용 — 종류 → 분류 → 이름 순. 프론트가 종류별 탭으로 갈라 보여준다.
    List<RateItem> findAllByOrderByRateTypeAscCategoryAscNameAsc();
}
