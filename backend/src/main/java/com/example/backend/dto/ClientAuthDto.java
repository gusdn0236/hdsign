package com.example.backend.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

public class ClientAuthDto {

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class LoginRequest {
        private String username;
        private String password;
    }

    @Getter @AllArgsConstructor
    public static class LoginResponse {
        private String token;
        private String companyName;
        private String contactName;
        private String username;
    }
}
