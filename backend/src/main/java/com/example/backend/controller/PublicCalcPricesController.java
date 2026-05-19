package com.example.backend.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 단가 계산기가 로그인 없이 가격 데이터를 읽기 위한 공개 엔드포인트.
 * SecurityConfig 의 {@code /api/public/**} permitAll 패턴에 매치.
 *
 * 디스크의 prices.json (라이브) 우선, 없으면 classpath 의 baseline 으로 폴백.
 * 첫 배포 직후나 라이브 데이터가 없는 환경에서도 정상 응답.
 *
 * 프론트의 usePrices() 가 매 페이지 로드마다 이 엔드포인트를 호출 — admin 이 단가표
 * 갱신하면 계산기 페이지 새로고침으로 즉시 반영. fetch 실패 시 프론트가 정적 폴백.
 */
@RestController
@RequestMapping("/api/public/calc-prices")
public class PublicCalcPricesController {

    @Value("${calc.data-dir:../frontend/src/data/calc}")
    private String dataDir;

    private static final String BASELINE_RESOURCE = "calc/prices_baseline.json";
    private static final ObjectMapper JSON = new ObjectMapper();

    @GetMapping
    public ResponseEntity<JsonNode> getPrices() throws IOException {
        Path prices = Paths.get(dataDir, "prices.json").toAbsolutePath().normalize();
        if (Files.exists(prices)) {
            return ResponseEntity.ok(JSON.readTree(Files.readString(prices)));
        }
        try (InputStream in = new ClassPathResource(BASELINE_RESOURCE).getInputStream()) {
            return ResponseEntity.ok(JSON.readTree(in));
        }
    }
}
