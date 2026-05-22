package com.example.backend.service;

import com.example.backend.dto.AuthDto;
import com.example.backend.entity.Admin;
import com.example.backend.repository.AdminRepository;
import com.example.backend.security.JwtUtil;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final AdminRepository adminRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;

    // 데모(둘러보기) 관리자 아이디 — 이 아이디로 로그인하면 변경 불가 토큰을 발급한다.
    @Value("${demo.admin.username:}")
    private String demoAdminUsername;

    public AuthDto.LoginResponse login(AuthDto.LoginRequest req) {
        Admin admin = adminRepository.findByUsername(req.getUsername())
            .orElseThrow(() -> new IllegalArgumentException("아이디 또는 비밀번호가 올바르지 않습니다."));

        if (!passwordEncoder.matches(req.getPassword(), admin.getPassword())) {
            throw new IllegalArgumentException("아이디 또는 비밀번호가 올바르지 않습니다.");
        }

        String token = isDemoAccount(admin.getUsername())
            ? jwtUtil.generateDemoAdminToken(admin.getUsername())
            : jwtUtil.generateToken(admin.getUsername());
        return new AuthDto.LoginResponse(token, admin.getName());
    }

    private boolean isDemoAccount(String username) {
        return demoAdminUsername != null
            && !demoAdminUsername.isBlank()
            && demoAdminUsername.equalsIgnoreCase(username);
    }
}
