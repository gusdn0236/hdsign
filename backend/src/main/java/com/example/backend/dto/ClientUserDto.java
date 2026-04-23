package com.example.backend.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

public class ClientUserDto {

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class CreateRequest {
        private String username;
        private String password;
        private String companyName;
        private String contactName;
        private String phone;
        private String email;
    }

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class UpdateRequest {
        private String companyName;
        private String contactName;
        private String phone;
        private String email;
        private Boolean isActive;
    }

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class ResetPasswordRequest {
        private String newPassword;
    }

    @Getter @AllArgsConstructor
    public static class Response {
        private Long id;
        private String username;
        private String companyName;
        private String contactName;
        private String phone;
        private String email;
        private Boolean isActive;
        private String createdAt;
    }
}
