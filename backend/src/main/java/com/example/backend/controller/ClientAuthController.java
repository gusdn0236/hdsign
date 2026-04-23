package com.example.backend.controller;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.service.ClientService;
import com.example.backend.service.MagicLinkService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.Map;

@RestController
@RequestMapping("/api/client/auth")
@RequiredArgsConstructor
public class ClientAuthController {

    private final ClientService clientService;
    private final MagicLinkService magicLinkService;

    @PostMapping("/login")
    public ResponseEntity<ClientAuthDto.LoginResponse> login(@RequestBody ClientAuthDto.LoginRequest req) {
        return ResponseEntity.ok(clientService.login(req.getUsername(), req.getPassword()));
    }

    @PostMapping("/magic-link/send")
    public ResponseEntity<Map<String, String>> sendMagicLink(
            @RequestBody Map<String, String> body,
            HttpServletRequest request
    ) {
        String email = body.getOrDefault("email", "").trim().toLowerCase();
        if (email.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "이메일을 입력해주세요."));
        }

        magicLinkService.sendMagicLink(email, extractFrontendBaseUrl(request));
        return ResponseEntity.ok(Map.of("message", "로그인 링크가 발송되었습니다. 이메일을 확인해주세요."));
    }

    @GetMapping("/magic-link/verify")
    public ResponseEntity<ClientAuthDto.LoginResponse> verifyMagicLink(@RequestParam String token) {
        return ResponseEntity.ok(magicLinkService.verifyMagicLink(token));
    }

    @PostMapping("/register")
    public ResponseEntity<Map<String, String>> register(
            @RequestBody Map<String, String> body,
            HttpServletRequest request
    ) {
        String email = body.getOrDefault("email", "").trim().toLowerCase();
        String companyName = body.getOrDefault("companyName", "").trim();
        String contactName = body.getOrDefault("contactName", "").trim();
        String phone = body.getOrDefault("phone", "").trim();

        if (email.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "이메일을 입력해주세요."));
        }
        if (companyName.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "상호명을 입력해주세요."));
        }
        if (contactName.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "담당자 성함을 입력해주세요."));
        }
        if (phone.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "전화번호를 입력해주세요."));
        }

        MagicLinkService.RegistrationRequestResult result = magicLinkService.requestRegistration(
                email,
                companyName,
                contactName,
                phone,
                extractFrontendBaseUrl(request)
        );

        return switch (result) {
            case CREATED -> ResponseEntity.ok(Map.of(
                    "status", "CREATED",
                    "message", "가입 신청이 접수되었습니다. 관리자 확인 후 로그인 링크가 발송됩니다."
            ));
            case ALREADY_PENDING -> ResponseEntity.ok(Map.of(
                    "status", "ALREADY_PENDING",
                    "message", "이미 가입 신청이 접수된 이메일입니다. 확인 안내 메일을 다시 보내드렸습니다."
            ));
            case ALREADY_REGISTERED -> ResponseEntity.ok(Map.of(
                    "status", "ALREADY_REGISTERED",
                    "message", "이미 등록된 이메일입니다. 로그인 링크를 해당 메일로 발송했습니다."
            ));
        };
    }

    private String extractFrontendBaseUrl(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank()) {
            return origin.trim();
        }

        String referer = request.getHeader("Referer");
        if (referer == null || referer.isBlank()) {
            return "";
        }

        try {
            URI uri = URI.create(referer.trim());
            return uri.getScheme() + "://" + uri.getAuthority();
        } catch (Exception ignored) {
            return "";
        }
    }
}
