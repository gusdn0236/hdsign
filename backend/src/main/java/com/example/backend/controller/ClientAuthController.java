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

    private static final String MSG_EMAIL_REQUIRED =
            "\uC774\uBA54\uC77C\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_COMPANY_REQUIRED =
            "\uC0C1\uD638\uBA85\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_CONTACT_REQUIRED =
            "\uB2F4\uB2F9\uC790 \uC131\uD568\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_PHONE_REQUIRED =
            "\uC804\uD654\uBC88\uD638\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_PHONE_INVALID =
            "\uC804\uD654\uBC88\uD638 \uD615\uC2DD\uC744 \uD655\uC778\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_LOGIN_LINK_SENT =
            "\uB85C\uADF8\uC778 \uB9C1\uD06C\uAC00 \uBC1C\uC1A1\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC774\uBA54\uC77C\uC744 \uD655\uC778\uD574\uC8FC\uC138\uC694.";
    private static final String MSG_REGISTER_CREATED =
            "\uAC00\uC785 \uC2E0\uCCAD\uC774 \uC811\uC218\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uAD00\uB9AC\uC790 \uD655\uC778 \uD6C4 \uB85C\uADF8\uC778 \uB9C1\uD06C\uAC00 \uBC1C\uC1A1\uB429\uB2C8\uB2E4.";
    private static final String MSG_REGISTER_PENDING =
            "\uC774\uBBF8 \uAC00\uC785 \uC2E0\uCCAD\uC774 \uC811\uC218\uB41C \uC774\uBA54\uC77C\uC785\uB2C8\uB2E4. \uD655\uC778 \uC548\uB0B4 \uBA54\uC77C\uC744 \uB2E4\uC2DC \uBCF4\uB0B4\uB4DC\uB838\uC2B5\uB2C8\uB2E4.";
    private static final String MSG_REGISTER_ALREADY_REGISTERED =
            "\uC774\uBBF8 \uB4F1\uB85D\uB41C \uC774\uBA54\uC77C\uC785\uB2C8\uB2E4. \uB85C\uADF8\uC778 \uB9C1\uD06C\uB97C \uD574\uB2F9 \uBA54\uC77C\uB85C \uBC1C\uC1A1\uD588\uC2B5\uB2C8\uB2E4.";

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
            return ResponseEntity.badRequest().body(Map.of("message", MSG_EMAIL_REQUIRED));
        }

        magicLinkService.sendMagicLink(email, extractFrontendBaseUrl(request));
        return ResponseEntity.ok(Map.of("message", MSG_LOGIN_LINK_SENT));
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
        String phone = normalizePhone(body.getOrDefault("phone", ""));

        if (email.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", MSG_EMAIL_REQUIRED));
        }
        if (companyName.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", MSG_COMPANY_REQUIRED));
        }
        if (contactName.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", MSG_CONTACT_REQUIRED));
        }
        if (phone.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", MSG_PHONE_REQUIRED));
        }
        if (phone.length() < 9 || phone.length() > 11) {
            return ResponseEntity.badRequest().body(Map.of("message", MSG_PHONE_INVALID));
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
                    "message", MSG_REGISTER_CREATED
            ));
            case ALREADY_PENDING -> ResponseEntity.ok(Map.of(
                    "status", "ALREADY_PENDING",
                    "message", MSG_REGISTER_PENDING
            ));
            case ALREADY_REGISTERED -> ResponseEntity.ok(Map.of(
                    "status", "ALREADY_REGISTERED",
                    "message", MSG_REGISTER_ALREADY_REGISTERED
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

    private String normalizePhone(String phone) {
        return phone == null ? "" : phone.replaceAll("[^0-9]", "");
    }
}
