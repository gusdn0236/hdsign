package com.example.backend.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
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
 *  - {@code prices_baseline.json} 은 HDCalc.js 에서 추출한 영구 정답지(읽기 전용).
 *  - {@code prices.json} 은 실제 계산기에 사용되는 라이브 데이터. 관리자가 엑셀 업로드 후
 *    셀별 승인 절차를 거쳐 갱신함. 갱신 시 타임스탬프 백업 자동 생성.
 *  - xlsx 파싱과 diff 계산은 브라우저에서 진행됨(SheetJS) — 이 컨트롤러는 파일 IO만.
 *
 * 데이터 디렉터리는 {@code calc.data-dir} 프로퍼티로 설정. dev 기본값은 프론트엔드의
 * 데이터 폴더(Vite 가 import 가능한 경로). prod 에서는 영속 디스크/마운트 경로 권장.
 */
@RestController
@RequestMapping("/api/admin/calc-prices")
@RequiredArgsConstructor
public class CalcPricesController {

    @Value("${calc.data-dir:../frontend/src/data/calc}")
    private String dataDir;

    private static final String BASELINE_NAME = "prices_baseline.json";
    private static final String PRICES_NAME = "prices.json";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** 영구 baseline — 읽기 전용. */
    @GetMapping("/baseline")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<JsonNode> getBaseline() throws IOException {
        return ResponseEntity.ok(readJson(baselinePath()));
    }

    /** 라이브 가격 데이터. 아직 저장 전이면 baseline 으로 시드해서 반환. */
    @GetMapping("/current")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<JsonNode> getCurrent() throws IOException {
        Path p = pricesPath();
        if (!Files.exists(p)) {
            return ResponseEntity.ok(readJson(baselinePath()));
        }
        return ResponseEntity.ok(readJson(p));
    }

    /**
     * 새 가격 데이터 저장. 저장 직전의 prices.json 을 타임스탬프 .bak 으로 보존(롤백 대비).
     * 요청 본문은 baseline 과 동일한 shape({@code _meta}, {@code calculators})이어야 하지만
     * 여기서 스키마 검증은 하지 않음 — 프론트가 baseline 구조 그대로 보내는 책임.
     */
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

    private Path baselinePath() {
        return Paths.get(dataDir, BASELINE_NAME).toAbsolutePath().normalize();
    }

    private Path pricesPath() {
        return Paths.get(dataDir, PRICES_NAME).toAbsolutePath().normalize();
    }

    private JsonNode readJson(Path p) throws IOException {
        return JSON.readTree(Files.readString(p));
    }
}
