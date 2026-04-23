package com.example.backend.controller;

import com.example.backend.dto.ClientUserDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.repository.ClientUserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/admin/clients")
@RequiredArgsConstructor
public class AdminClientController {

    private final ClientUserRepository clientUserRepository;
    private final PasswordEncoder passwordEncoder;

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
        if (req.getUsername() == null || req.getUsername().isBlank())
            throw new IllegalArgumentException("아이디를 입력해주세요.");
        if (req.getPassword() == null || req.getPassword().length() < 4)
            throw new IllegalArgumentException("비밀번호는 4자 이상이어야 합니다.");
        if (req.getCompanyName() == null || req.getCompanyName().isBlank())
            throw new IllegalArgumentException("업체명을 입력해주세요.");

        if (clientUserRepository.existsByUsername(req.getUsername().trim()))
            throw new IllegalArgumentException("이미 사용 중인 아이디입니다.");

        ClientUser user = clientUserRepository.save(ClientUser.builder()
                .username(req.getUsername().trim())
                .password(passwordEncoder.encode(req.getPassword()))
                .companyName(req.getCompanyName().trim())
                .contactName(req.getContactName() != null ? req.getContactName().trim() : "")
                .phone(req.getPhone() != null ? req.getPhone().trim() : "")
                .email(req.getEmail() != null ? req.getEmail().trim().toLowerCase() : "")
                .isActive(true)
                .build());

        return ResponseEntity.ok(toResponse(user));
    }

    @PutMapping("/{id}")
    public ResponseEntity<ClientUserDto.Response> updateClient(
            @PathVariable Long id,
            @RequestBody ClientUserDto.UpdateRequest req
    ) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));

        if (req.getCompanyName() != null && !req.getCompanyName().isBlank())
            user.setCompanyName(req.getCompanyName().trim());
        if (req.getContactName() != null)
            user.setContactName(req.getContactName().trim());
        if (req.getPhone() != null)
            user.setPhone(req.getPhone().trim());
        if (req.getIsActive() != null)
            user.setIsActive(req.getIsActive());
        if (req.getEmail() != null && !req.getEmail().isBlank()) {
            String normalizedEmail = req.getEmail().trim().toLowerCase();
            clientUserRepository.findByEmail(normalizedEmail).ifPresent(existing -> {
                if (!existing.getId().equals(id))
                    throw new IllegalArgumentException("이미 등록된 이메일입니다.");
            });
            user.setEmail(normalizedEmail);
        }

        return ResponseEntity.ok(toResponse(clientUserRepository.save(user)));
    }

    @PostMapping("/{id}/reset-password")
    public ResponseEntity<Map<String, String>> resetPassword(
            @PathVariable Long id,
            @RequestBody ClientUserDto.ResetPasswordRequest req
    ) {
        if (req.getNewPassword() == null || req.getNewPassword().length() < 4)
            throw new IllegalArgumentException("비밀번호는 4자 이상이어야 합니다.");

        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));

        user.setPassword(passwordEncoder.encode(req.getNewPassword()));
        clientUserRepository.save(user);
        return ResponseEntity.ok(Map.of("message", "비밀번호가 변경되었습니다."));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteClient(@PathVariable Long id) {
        clientUserRepository.delete(
                clientUserRepository.findById(id)
                        .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."))
        );
        return ResponseEntity.noContent().build();
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
}
