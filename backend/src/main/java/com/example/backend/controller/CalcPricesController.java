package com.example.backend.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 잔넬·아크릴·에폭시 등 단가 계산기의 가격 데이터를 관리.
 *
 * 흐름:
 *  - {@code prices_baseline.json} (classpath: /calc/prices_baseline.json) — 영구 정답지.
 *    JAR 에 번들돼 Railway 등 컨테이너 환경에서도 항상 접근 가능.
 *  - {@code prices.json} (디스크: {@code calc.data-dir}) — 라이브 가격, 관리자가 갱신.
 *    저장 시 자동 .bak 백업. 운영 환경에선 영속 볼륨 마운트 권장.
 *
 * xlsx 파싱·diff 는 브라우저(SheetJS)에서 — 이 컨트롤러는 JSON IO 만.
 */
@RestController
@RequestMapping("/api/admin/calc-prices")
@RequiredArgsConstructor
public class CalcPricesController {

    @Value("${calc.data-dir:../frontend/src/data/calc}")
    private String dataDir;

    private static final String BASELINE_RESOURCE = "calc/prices_baseline.json";
    private static final String PRICES_NAME = "prices.json";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** 영구 baseline — classpath 에서 읽음. 컨테이너 환경에서도 안정적. */
    @GetMapping("/baseline")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<JsonNode> getBaseline() throws IOException {
        return ResponseEntity.ok(readBaseline());
    }

    /** 라이브 가격 데이터. 디스크에 prices.json 없으면 baseline 으로 시드해 반환. */
    @GetMapping("/current")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<JsonNode> getCurrent() throws IOException {
        Path p = pricesPath();
        if (Files.exists(p)) {
            return ResponseEntity.ok(JSON.readTree(Files.readString(p)));
        }
        return ResponseEntity.ok(readBaseline());
    }

    /** 새 가격 저장 — 기존 파일 자동 .bak 백업. */
    @PutMapping("/current")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> saveCurrent(@RequestBody JsonNode prices) throws IOException {
        Path p = pricesPath();
        Files.createDirectories(p.getParent());

        if (Files.exists(p)) {
            String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss"));
            Path backup = p.resolveSibling("prices_" + ts + ".json.bak");
            Files.copy(p, backup, StandardCopyOption.REPLACE_EXISTING);
        }

        Files.writeString(p, prices.toPrettyString());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("savedAt", Instant.now().toString());
        body.put("path", p.toAbsolutePath().toString());
        body.put("bytes", Files.size(p));
        return ResponseEntity.ok(body);
    }

    private JsonNode readBaseline() throws IOException {
        try (InputStream in = new ClassPathResource(BASELINE_RESOURCE).getInputStream()) {
            return JSON.readTree(in);
        }
    }

    private Path pricesPath() {
        return Paths.get(dataDir, PRICES_NAME).toAbsolutePath().normalize();
    }
}
