package com.example.backend.controller;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.service.ClientService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/client/auth")
@RequiredArgsConstructor
public class ClientAuthController {

    private final ClientService clientService;

    @PostMapping("/login")
    public ResponseEntity<ClientAuthDto.LoginResponse> login(@RequestBody ClientAuthDto.LoginRequest req) {
        return ResponseEntity.ok(clientService.login(req.getUsername(), req.getPassword()));
    }

    /** 가입 검색 — 거래처명 또는 이메일로 가입대기 행 후보를 찾는다. */
    @PostMapping("/signup/search")
    public ResponseEntity<ClientAuthDto.SignupSearchResponse> signupSearch(@RequestBody ClientAuthDto.SignupSearchRequest req) {
        return ResponseEntity.ok(clientService.signupSearch(req.getQuery()));
    }

    /** 가입 신청 — 검색 단계에서 받은 id 에 본인 정보 박고 PENDING_APPROVAL 전환. */
    @PostMapping("/signup")
    public ResponseEntity<java.util.Map<String, String>> signup(@RequestBody ClientAuthDto.SignupRequest req) {
        clientService.submitSignup(req);
        return ResponseEntity.ok(java.util.Map.of(
                "message", "가입 신청이 접수되었습니다. 관리자 확인 후 등록된 연락처로 안내드립니다."
        ));
    }
}
