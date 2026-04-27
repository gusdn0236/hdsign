package com.example.backend.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.util.List;

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

    /** 가입 검색 — 거래처명 또는 이메일로 본인 행을 식별. */
    @Getter @Setter @NoArgsConstructor
    public static class SignupSearchRequest {
        private String query;
    }

    @Getter @AllArgsConstructor
    public static class SignupSearchMatch {
        private Long id;
        private String companyName;
        private String emailMasked;   // ab***@d.com 형태로만 노출
    }

    @Getter @AllArgsConstructor
    public static class SignupSearchResponse {
        private List<SignupSearchMatch> matches;
    }

    /** 가입 신청 — 검색 단계에서 받은 id 와 함께 본인이 쓸 아이디/전화/이메일 전송. */
    @Getter @Setter @NoArgsConstructor
    public static class SignupRequest {
        private Long id;
        private String username;
        private String phone;
        private String email;
    }
}
