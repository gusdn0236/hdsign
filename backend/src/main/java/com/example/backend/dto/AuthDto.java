package com.example.backend.dto;

import lombok.Data;

public class AuthDto {

    @Data
    public static class LoginRequest {
        private String username;
        private String password;
    }

    @Data
    public static class LoginResponse {
        private String token;
        private String name;

        public LoginResponse(String token, String name) {
            this.token = token;
            this.name = name;
        }
    }
}
