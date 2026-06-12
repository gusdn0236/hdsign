package com.example.backend.controller;

import com.example.backend.entity.Admin;
import com.example.backend.repository.AdminRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 로그인한 관리자 본인 프로필. /api/admin/** 라 SecurityConfig 가 ROLE_ADMIN 을 요구한다.
 *
 * <p>명세서 작성 잠금이 "ㅇㅇㅇ님이 작성중" 으로 띄울 표시 이름(admin.name)을 각자 본인이
 * 한 번 설정할 수 있게 한다. 이름이 비어있거나 일반값이면 프론트가 입력을 유도한다.
 */
@RestController
@RequestMapping("/api/admin/me")
@RequiredArgsConstructor
public class AdminProfileController {

    private final AdminRepository adminRepository;

    /** 내 계정 정보 — username + 표시이름(name). 명세서 잠금이 "내 잠금" 판별과 표시이름에 쓴다. */
    @GetMapping
    public ResponseEntity<?> me() {
        String username = currentUsername();
        Admin admin = adminRepository.findByUsername(username).orElse(null);
        if (admin == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "계정을 찾을 수 없습니다."));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("username", admin.getUsername());
        body.put("name", admin.getName() == null ? "" : admin.getName());
        return ResponseEntity.ok(body);
    }

    /** 내 표시이름 설정/변경. 각자 본인이 자기 이름을 입력한다. 본문 { "name": "홍길동" }. */
    @PutMapping("/display-name")
    public ResponseEntity<?> updateDisplayName(@RequestBody(required = false) Map<String, Object> reqBody) {
        String name = reqBody != null && reqBody.get("name") instanceof String s ? s.trim() : "";
        if (name.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("message", "이름을 입력해 주세요."));
        }
        if (name.length() > 30) name = name.substring(0, 30);

        String username = currentUsername();
        Admin admin = adminRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        admin.setName(name);
        adminRepository.save(admin);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("username", username);
        body.put("name", name);
        return ResponseEntity.ok(body);
    }

    private static String currentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null ? auth.getName() : "unknown";
    }
}
