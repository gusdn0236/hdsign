package com.example.backend.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 단가 계산기 페이지가 로그인 없이 가격 데이터를 읽기 위한 공개 엔드포인트.
 * SecurityConfig 의 {@code /api/public/**} permitAll 패턴에 매치됨.
 *
 * 라이브 prices.json 이 아직 없으면 baseline 으로 폴백 — 첫 배포 직후에도 계산기가 동작.
 */
@RestController
@RequestMapping("/api/public/calc-prices")
public class PublicCalcPricesController {

    @Value("${calc.data-dir:../frontend/src/data/calc}")
    private String dataDir;

    private static final ObjectMapper JSON = new ObjectMapper();

    @GetMapping
    public ResponseEntity<JsonNode> getPrices() throws IOException {
        Path prices = Paths.get(dataDir, "prices.json").toAbsolutePath().normalize();
        if (Files.exists(prices)) {
            return ResponseEntity.ok(JSON.readTree(Files.readString(prices)));
        }
        Path baseline = Paths.get(dataDir, "prices_baseline.json").toAbsolutePath().normalize();
        return ResponseEntity.ok(JSON.readTree(Files.readString(baseline)));
    }
}
