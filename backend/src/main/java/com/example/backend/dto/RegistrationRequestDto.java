package com.example.backend.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;

public class RegistrationRequestDto {

    @Getter @AllArgsConstructor
    public static class Response {
        private Long id;
        private String email;
        private String companyName;
        private String contactName;
        private String phone;
        private String status;
        private String createdAt;
    }
}
