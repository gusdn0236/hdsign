package com.example.backend.controller;

import com.example.backend.dto.ClientUserDto;
import com.example.backend.dto.RegistrationRequestDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.service.MagicLinkService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/admin/clients")
@RequiredArgsConstructor
public class AdminClientController {

    private final ClientUserRepository clientUserRepository;
    private final MagicLinkService magicLinkService;

    @GetMapping
    public ResponseEntity<List<ClientUserDto.Response>> listClients() {
        return ResponseEntity.ok(
                clientUserRepository.findAllByOrderByCreatedAtDesc()
                        .stream()
                        .map(this::toResponse)
                        .toList()
        );
    }

    @PostMapping
    public ResponseEntity<ClientUserDto.Response> createClient(@RequestBody ClientUserDto.CreateRequest req) {
        throw new ResponseStatusException(
                HttpStatus.METHOD_NOT_ALLOWED,
                "거래처는 가입 신청 승인으로만 등록할 수 있습니다."
        );
    }

    @PutMapping("/{id}")
    public ResponseEntity<ClientUserDto.Response> updateClient(
            @PathVariable Long id,
            @RequestBody ClientUserDto.UpdateRequest req
    ) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));

        if (req.getCompanyName() != null && !req.getCompanyName().isBlank()) {
            user.setCompanyName(req.getCompanyName().trim());
        }
        if (req.getContactName() != null) {
            user.setContactName(req.getContactName().trim());
        }
        if (req.getPhone() != null) {
            user.setPhone(req.getPhone().trim());
        }
        if (req.getIsActive() != null) {
            user.setIsActive(req.getIsActive());
        }
        if (req.getEmail() != null && !req.getEmail().isBlank()) {
            String normalizedEmail = req.getEmail().trim().toLowerCase();
            clientUserRepository.findByEmail(normalizedEmail).ifPresent(existing -> {
                if (!existing.getId().equals(id)) {
                    throw new IllegalArgumentException("이미 등록된 이메일입니다.");
                }
            });
            user.setEmail(normalizedEmail);
        }

        return ResponseEntity.ok(toResponse(clientUserRepository.save(user)));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteClient(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        clientUserRepository.delete(user);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/registrations")
    public ResponseEntity<List<RegistrationRequestDto.Response>> listRegistrations() {
        return ResponseEntity.ok(magicLinkService.getPendingRegistrations());
    }

    @PostMapping("/registrations/{id}/approve")
    public ResponseEntity<Map<String, String>> approve(
            @PathVariable Long id,
            HttpServletRequest request
    ) {
        magicLinkService.approveRegistration(id, extractFrontendBaseUrl(request));
        return ResponseEntity.ok(Map.of("message", "승인되었습니다. 로그인 링크가 발송되었습니다."));
    }

    @PostMapping("/registrations/{id}/reject")
    public ResponseEntity<Map<String, String>> reject(@PathVariable Long id) {
        magicLinkService.rejectRegistration(id);
        return ResponseEntity.ok(Map.of("message", "거절되었습니다."));
    }

    private ClientUserDto.Response toResponse(ClientUser user) {
        return new ClientUserDto.Response(
                user.getId(),
                user.getUsername(),
                user.getCompanyName(),
                user.getContactName(),
                user.getPhone(),
                user.getEmail(),
                user.getIsActive(),
                user.getCreatedAt() != null ? user.getCreatedAt().toString() : null
        );
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
