package com.example.backend.controller;

import com.example.backend.entity.AutoQuoteCorrection;
import com.example.backend.repository.AutoQuoteCorrectionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

/**
 * @slice-3 자동견적 보정(correction) 공유 저장소 API.
 *
 * <p>{@code GET  /api/admin/autoquote/corrections} — 서버에 저장된 모든 공유 보정을 JSON 배열로.
 * <p>{@code POST /api/admin/autoquote/corrections} — 새 보정을 영속화하고 저장된 레코드를 반환.
 *
 * <p>인가: 클래스 전체가 {@code /api/admin/**} 아래라 SecurityConfig 가 ROLE_ADMIN 을 요구하고,
 * {@link PreAuthorize} 로 한 번 더 못 박는다({@link AdminAutoQuoteController} 와 동일 메커니즘).
 * JWT 없으면 401, 비-admin JWT 면 403.
 *
 * <p><b>author 는 인증된 principal 에서만 가져온다</b>(SecurityContext 의 authentication name) —
 * 클라이언트 본문에 author 가 실려와도 무시·덮어쓴다(스푸핑 불가). priority 는 생략 시 100 기본.
 * 필수 필드(featureKey/correctedUnitPrice/explanation) 누락 시 400.
 */
@RestController
@RequestMapping("/api/admin/autoquote")
@RequiredArgsConstructor
public class AutoQuoteCorrectionsController {

    /** priority 미지정 시 적용되는 기본 우선순위(낮을수록 우선). */
    private static final int DEFAULT_PRIORITY = 100;

    private final AutoQuoteCorrectionRepository repository;

    /** 클라이언트 요청 본문. {@code author} 필드는 의도적으로 없다 — 서버가 principal 로 박는다. */
    public record CorrectionRequest(
            String featureKey,
            BigDecimal correctedUnitPrice,
            String explanation,
            Integer priority) {
    }

    /** 응답 형태(저장된 레코드의 모든 노출 필드). */
    public record CorrectionResponse(
            Long id,
            String featureKey,
            BigDecimal correctedUnitPrice,
            String explanation,
            String author,
            int priority,
            LocalDateTime createdAt) {

        static CorrectionResponse from(AutoQuoteCorrection c) {
            return new CorrectionResponse(
                    c.getId(),
                    c.getFeatureKey(),
                    c.getCorrectedUnitPrice(),
                    c.getExplanation(),
                    c.getAuthor(),
                    c.getPriority(),
                    c.getCreatedAt());
        }
    }

    @GetMapping("/corrections")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<List<CorrectionResponse>> list() {
        List<CorrectionResponse> body = repository.findAllByOrderByPriorityAscCreatedAtDesc()
                .stream()
                .map(CorrectionResponse::from)
                .toList();
        return ResponseEntity.ok(body);
    }

    @PostMapping("/corrections")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<?> create(@RequestBody(required = false) CorrectionRequest req) {
        if (req == null
                || isBlank(req.featureKey())
                || req.correctedUnitPrice() == null
                || isBlank(req.explanation())) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(java.util.Map.of(
                            "error", "missing_field",
                            "message", "featureKey, correctedUnitPrice, explanation 은 필수입니다."));
        }

        AutoQuoteCorrection saved = repository.save(AutoQuoteCorrection.builder()
                .featureKey(req.featureKey().trim())
                .correctedUnitPrice(req.correctedUnitPrice())
                .explanation(req.explanation())
                // author 는 절대 본문에서 읽지 않는다 — 인증된 principal 이름이 진실의 원천.
                .author(currentPrincipalName())
                .priority(req.priority() != null ? req.priority() : DEFAULT_PRIORITY)
                .build());

        return ResponseEntity.status(HttpStatus.CREATED).body(CorrectionResponse.from(saved));
    }

    /** 인증된 사용자(관리자) 이름. @PreAuthorize 가 통과한 시점이라 항상 존재한다. */
    private static String currentPrincipalName() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null ? auth.getName() : "unknown";
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
