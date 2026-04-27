package com.example.backend.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.util.List;

public class ClientUserDto {

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class CreateRequest {
        private String username;
        private String password;
        private String companyName;
        private String networkFolderName;
        private String contactName;
        private String phone;
        private String email;
        // true 면 가입대기(PENDING_SIGNUP) 행으로 생성: username/password 무시, 이메일/전화도 빈 채로 OK.
        // 거래처가 가입 신청 시 채워진다.
        private Boolean pendingSignup;
    }

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class UpdateRequest {
        private String companyName;
        private String networkFolderName;
        private String contactName;
        private String phone;
        private String email;
        private Boolean isActive;
    }

    @Getter @NoArgsConstructor @AllArgsConstructor
    public static class ResetPasswordRequest {
        private String newPassword;
    }

    /** 미등록 폴더 일괄 등록용 — 행 배열을 한 번에 보내고 행별 결과 리포트를 받는다. */
    @Getter @Setter @NoArgsConstructor
    public static class BulkCreateRequest {
        private List<BulkCreateRow> rows;
    }

    @Getter @Setter @NoArgsConstructor
    public static class BulkCreateRow {
        private String networkFolderName;
        private String username;
        private String password;
        private String companyName;
        private String contactName;
        private String phone;
        private String email;
        // true 면 username/password 무시, PENDING_SIGNUP 으로 행 생성.
        private Boolean pendingSignup;
    }

    @Getter @AllArgsConstructor
    public static class Response {
        private Long id;
        private String username;
        private String companyName;
        private String networkFolderName;
        private String contactName;
        private String phone;
        private String email;
        private Boolean isActive;
        private String status;
        private String signupRequestedAt;
        private String createdAt;
    }
}
