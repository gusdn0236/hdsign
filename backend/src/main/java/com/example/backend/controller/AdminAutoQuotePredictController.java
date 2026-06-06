package com.example.backend.controller;

import com.example.backend.autoquote.predict.InvoiceEvidenceService;
import com.example.backend.autoquote.predict.PricePredictor;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 자동견적 <b>가격예측 + 근거 서빙</b> admin 전용 백엔드.
 *
 * <ul>
 *   <li>{@code POST /api/admin/autoquote/predict} — 거래처 + 품목들 → 과거 단가 기반 예측가/근거.
 *       {@link PricePredictor}(priced_index.json 코퍼스, build_learn_corpus.py 포팅) 사용.</li>
 *   <li>{@code GET  /api/admin/autoquote/evidence/{invoiceIdx}?file=easyform_...json} — 예측에
 *       쓰인 과거 명세서 grid(+가능하면 작업지시서 사진). {@link InvoiceEvidenceService} 사용.</li>
 * </ul>
 *
 * <p><b>Iron Law</b>: priced_index/명세서/사진 = 회사 기밀 → admin JWT only(공개 Pages 금지).
 * 클래스가 {@code /api/admin/**} 아래라 SecurityConfig 가 ROLE_ADMIN 을 요구하고,
 * {@link PreAuthorize} 로 다시 못 박는다(JWT 없으면 401, 비-admin 이면 403). 코퍼스/명세서
 * 미프로비저닝 시 스택트레이스 대신 503/404 의 안정된 JSON 계약으로 graceful 응답한다.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
@RequiredArgsConstructor
public class AdminAutoQuotePredictController {

    private final PricePredictor predictor;
    private final InvoiceEvidenceService evidenceService;

    /** 예측 요청 본문. items 각 줄은 {text, material, size, qty}. */
    public record PredictRequest(String client, List<ItemRequest> items) {
    }

    public record ItemRequest(String text, String material, String size, String qty) {
    }

    /** 단가 찾아보기 요청: 거래처 + 품목 1개 + (선택) 최대 개수. */
    public record LookupRequest(String client, ItemRequest item, Integer limit) {
    }

    @PostMapping(value = "/predict", consumes = MediaType.APPLICATION_JSON_VALUE)
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> predict(@RequestBody(required = false) PredictRequest req) {
        if (req == null || req.items() == null || req.items().isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", "missing_field",
                            "message", "client 와 items(최소 1개)는 필수입니다."));
        }
        List<PricePredictor.Item> items = req.items().stream()
                .map(i -> new PricePredictor.Item(i.text(), i.material(), i.size(), i.qty()))
                .toList();

        List<PricePredictor.Prediction> out = predictor.predict(req.client(), items);
        if (out == null) {
            // priced_index 미프로비저닝 → graceful 503(기밀 누수 없음).
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "autoquote_data_unavailable"));
        }
        return ResponseEntity.ok(out);
    }

    /**
     * 단가 찾아보기 — 한 품목의 품목코드 기준 과거 단가 후보들을 ①같은거래처 ②타거래처 ③관련 순으로.
     * predict 와 달리 한 품목에 대해 <b>여러 후보(리스트)</b>를 돌려준다.
     */
    @PostMapping(value = "/predict/lookup", consumes = MediaType.APPLICATION_JSON_VALUE)
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> lookup(@RequestBody(required = false) LookupRequest req) {
        if (req == null || req.item() == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", "missing_field", "message", "item 은 필수입니다."));
        }
        ItemRequest i = req.item();
        PricePredictor.Item it = new PricePredictor.Item(i.text(), i.material(), i.size(), i.qty());
        int limit = req.limit() != null ? req.limit() : 8;
        List<PricePredictor.Prediction> out = predictor.lookup(req.client(), it, limit);
        if (out == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "autoquote_data_unavailable"));
        }
        return ResponseEntity.ok(out);
    }

    /**
     * 유사 품목코드 추천 — 입력 코드와 비슷한 코퍼스 코드들(같은 자재 다른 표기·오타)을 건수순으로.
     * 단가찾아보기에서 '비슷한 코드' 칩으로 띄워, 흩어진 표기를 함께 검색하도록 돕는다.
     */
    @GetMapping("/predict/similar-codes")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> similarCodes(@RequestParam(required = false) String code,
                                          @RequestParam(required = false) Integer limit) {
        if (code == null || code.isBlank()) {
            return ResponseEntity.ok(List.of());
        }
        int n = limit != null ? limit : 8;
        return ResponseEntity.ok(predictor.similarCodes(code, n));
    }

    @GetMapping("/evidence/{invoiceIdx}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> evidence(@PathVariable("invoiceIdx") String invoiceIdx,
                                      @RequestParam("file") String file) {
        if (!evidenceService.isValidFile(file)) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", "invalid_file",
                            "message", "file 은 easyform_*_*.json 형식이어야 합니다."));
        }
        InvoiceEvidenceService.Evidence ev = evidenceService.find(file, invoiceIdx);
        if (ev == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "evidence_not_found",
                            "message", "해당 명세서를 찾지 못했습니다."));
        }
        return ResponseEntity.ok(ev);
    }
}
