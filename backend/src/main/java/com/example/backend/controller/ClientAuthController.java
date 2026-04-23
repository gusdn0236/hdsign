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
}
