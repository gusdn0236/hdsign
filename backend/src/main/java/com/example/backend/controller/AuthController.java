package com.example.backend.controller;

import com.example.backend.dto.AuthDto;
import com.example.backend.security.LoginAttemptLimiter;
import com.example.backend.service.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private static final String SCOPE = "admin";

    private final AuthService authService;
    private final LoginAttemptLimiter loginAttemptLimiter;

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody AuthDto.LoginRequest request, HttpServletRequest http) {
        long locked = loginAttemptLimiter.lockedMinutes(SCOPE, request.getUsername(), http);
        if (locked > 0) {
            return ResponseEntity.status(429).body(Map.of("message", loginAttemptLimiter.lockMessage(locked)));
        }
        try {
            AuthDto.LoginResponse response = authService.login(request);
            loginAttemptLimiter.recordSuccess(SCOPE, request.getUsername(), http);
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            loginAttemptLimiter.recordFailure(SCOPE, request.getUsername(), http);
            return ResponseEntity.status(401).body(Map.of("message", e.getMessage()));
        }
    }
}
