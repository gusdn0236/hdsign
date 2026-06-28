package com.example.backend.repository;

import com.example.backend.entity.LedTrainingSample;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

/**
 * LED 개수 학습 샘플 저장소. 타입별 계수 적합을 위해 led_type 단위로 샘플을 조회한다.
 */
public interface LedTrainingSampleRepository extends JpaRepository<LedTrainingSample, Long> {
    List<LedTrainingSample> findByLedType(String ledType);
}
