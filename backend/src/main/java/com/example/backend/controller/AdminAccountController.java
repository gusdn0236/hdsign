package com.example.backend.controller;

import com.example.backend.entity.Admin;
import com.example.backend.repository.AdminRepository;
import com.example.backend.security.LoginAttemptLimiter;
import jakarta.servlet.http.HttpServletRequest;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 관리자 본인 비밀번호 변경. 예전엔 DB 에 직접 넣은 계정이라 바꿀 방법이 없었다(2026-11-19 추가).
 * 현재 비밀번호를 다시 확인한다 — 토큰만 훔친 사람이 비번까지 바꿔 계정을 빼앗지 못하게.
 * 현재 비번 오답도 로그인 실패와 같은 잠금 카운터에 넣는다(토큰 쥔 채 비번 대입 방지).
 */
@Slf4j
@RestController
@RequestMapping("/api/admin/account")
@RequiredArgsConstructor
public class AdminAccountController {

    private static final String SCOPE = "admin";
    static final int MIN_LENGTH = 12;

    private final AdminRepository adminRepository;
    private final PasswordEncoder passwordEncoder;
    private final LoginAttemptLimiter loginAttemptLimiter;

    @Data
    public static class ChangePasswordRequest {
        private String currentPassword;
        private String newPassword;
    }

    @PostMapping("/password")
    public ResponseEntity<?> changePassword(@RequestBody ChangePasswordRequest req,
                                            Authentication auth,
                                            HttpServletRequest http) {
        String username = auth.getName();
        long locked = loginAttemptLimiter.lockedMinutes(SCOPE, username, http);
        if (locked > 0) {
            return ResponseEntity.status(429).body(Map.of("message", loginAttemptLimiter.lockMessage(locked)));
        }
        Admin admin = adminRepository.findByUsername(username).orElse(null);
        if (admin == null) {
            return ResponseEntity.status(404).body(Map.of("message", "관리자 계정을 찾을 수 없습니다."));
        }
        if (req.getCurrentPassword() == null
                || !passwordEncoder.matches(req.getCurrentPassword(), admin.getPassword())) {
            loginAttemptLimiter.recordFailure(SCOPE, username, http);
            return ResponseEntity.badRequest().body(Map.of("message", "현재 비밀번호가 올바르지 않습니다."));
        }
        String next = req.getNewPassword();
        if (next == null || next.length() < MIN_LENGTH) {
            return ResponseEntity.badRequest().body(Map.of("message", "새 비밀번호는 " + MIN_LENGTH + "자 이상이어야 합니다."));
        }
        if (passwordEncoder.matches(next, admin.getPassword())) {
            return ResponseEntity.badRequest().body(Map.of("message", "지금 비밀번호와 다른 비밀번호를 입력해주세요."));
        }
        admin.setPassword(passwordEncoder.encode(next));
        adminRepository.save(admin);
        loginAttemptLimiter.recordSuccess(SCOPE, username, http);
        log.info("관리자 비밀번호 변경 user={}", username);
        return ResponseEntity.ok(Map.of("message", "비밀번호를 변경했습니다."));
    }
}
