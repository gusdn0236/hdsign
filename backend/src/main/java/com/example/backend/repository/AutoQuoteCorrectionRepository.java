package com.example.backend.repository;

import com.example.backend.entity.AutoQuoteCorrection;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

/**
 * 자동견적 보정 저장소. 모든 보정은 관리자 전체에 공유되므로(테넌트 구분 없음),
 * 목록 조회는 priority(낮을수록 우선) → 최신순으로 안정 정렬해 돌려준다.
 */
public interface AutoQuoteCorrectionRepository extends JpaRepository<AutoQuoteCorrection, Long> {
    List<AutoQuoteCorrection> findAllByOrderByPriorityAscCreatedAtDesc();
}
