package com.example.backend.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

import java.io.IOException;

/**
 * 인증 자격(JWT)이 없거나 유효하지 않아 보호된 엔드포인트에 접근하지 못할 때 401 을 낸다.
 *
 * Spring Security 의 기본 동작은 (httpBasic/formLogin 미설정 시) 인증되지 않은 요청도
 * 403 으로 돌려보내는데, REST 의미상 "자격 없음"은 401 이 맞다. 이 진입점을 설정하면
 * - 토큰이 아예 없거나 유효하지 않음 → 401 (여기)
 * - 유효한 토큰이지만 권한(role) 부족 → 403 (AccessDeniedHandler 기본)
 * 으로 의미가 분리된다. 프론트 api/client.js 는 401/403 을 동일하게 "세션 만료"로 처리하므로
 * 기존 흐름은 그대로 유지된다.
 */
@Component
public class RestAuthenticationEntryPoint implements AuthenticationEntryPoint {

    @Override
    public void commence(
            HttpServletRequest request,
            HttpServletResponse response,
            AuthenticationException authException
    ) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(
            "{\"status\":401,\"message\":\"인증이 필요합니다.\"}");
    }
}
