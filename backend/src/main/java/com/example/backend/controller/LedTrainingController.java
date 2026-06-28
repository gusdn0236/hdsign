package com.example.backend.controller;

import com.example.backend.entity.LedTrainingSample;
import com.example.backend.repository.LedTrainingSampleRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LED 개수 머신러닝 피드백 루프 API.
 *
 * <p>{@code POST /api/admin/autoquote/led-samples} — 현장 실측 LED 개수(벡터 면적/둘레 라벨)를 적재.
 * <p>{@code GET  /api/admin/autoquote/led-coeffs} — 타입별 회귀계수(면적당·둘레당 LED)를 최소제곱 적합해 반환.
 *
 * <p>인가: 클래스 전체가 {@code /api/admin/**} 아래라 SecurityConfig 가 ROLE_ADMIN 을 요구하고,
 * {@link PreAuthorize} 로 한 번 더 못 박는다({@link AutoQuoteCorrectionsController} 와 동일 메커니즘).
 *
 * <p>모델: {@code count ≈ area*A + perim*B}(절편 없음). 적합·이상치 제거·제약은 {@link LedCoeffFitter} 에 위임.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
@RequiredArgsConstructor
public class LedTrainingController {

    /** 타입별 계수를 산출하려면 최소 이만큼의 샘플이 있어야 한다(미만이면 응답에서 생략 → 프론트 기본값 유지). */
    private static final int MIN_SAMPLES = 6;

    private final LedTrainingSampleRepository repository;

    /** 학습 샘플 적재 요청 본문. */
    public record SamplesRequest(List<Sample> samples) {
    }

    /** 단일 학습 샘플(현장 실측 1건). */
    public record Sample(
            String ledType,
            double area,
            double perim,
            int actualCount,
            String orderNumber,
            String polysJson) {
    }

    /** 타입별 적합 결과. areaPerLed = LED 1개당 면적(mm^2), perimPerLed = LED 1개당 둘레(mm), n = 사용 샘플 수. */
    public record Coeff(double areaPerLed, double perimPerLed, int n) {
    }

    @PostMapping("/led-samples")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> ingest(@RequestBody(required = false) SamplesRequest req) {
        if (req == null || req.samples() == null || req.samples().isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of(
                            "error", "missing_field",
                            "message", "samples 는 비어 있지 않은 배열이어야 합니다."));
        }

        List<LedTrainingSample> rows = new ArrayList<>();
        for (Sample s : req.samples()) {
            // 부적합 샘플은 조용히 건너뛴다(ledType 공백, 면적 비양수, 개수 비양수).
            if (s == null
                    || s.ledType() == null || s.ledType().isBlank()
                    || s.area() <= 0
                    || s.actualCount() <= 0) {
                continue;
            }
            rows.add(LedTrainingSample.builder()
                    .ledType(s.ledType().trim())
                    .area(s.area())
                    .perim(s.perim())
                    .actualCount(s.actualCount())
                    .orderNumber(s.orderNumber())
                    .polysJson(s.polysJson())
                    .build());
        }

        repository.saveAll(rows);
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("saved", rows.size()));
    }

    @GetMapping("/led-coeffs")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> coeffs() {
        // 타입별로 샘플을 묶어 적합. 타입 키 안정 정렬을 위해 LinkedHashMap.
        Map<String, List<LedTrainingSample>> byType = new LinkedHashMap<>();
        for (LedTrainingSample s : repository.findAll()) {
            byType.computeIfAbsent(s.getLedType(), k -> new ArrayList<>()).add(s);
        }

        Map<String, Coeff> coeffs = new LinkedHashMap<>();
        for (Map.Entry<String, List<LedTrainingSample>> e : byType.entrySet()) {
            Coeff c = LedCoeffFitter.fit(e.getValue(), MIN_SAMPLES);
            if (c != null) {
                coeffs.put(e.getKey(), c);
            }
        }

        return ResponseEntity.ok(Map.of("coeffs", coeffs));
    }
}
