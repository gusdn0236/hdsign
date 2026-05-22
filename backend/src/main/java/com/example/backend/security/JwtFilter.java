package com.example.backend.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

@Component
@RequiredArgsConstructor
public class JwtFilter extends OncePerRequestFilter {

    private final JwtUtil jwtUtil;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain chain
    ) throws ServletException, IOException {

        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            String token = header.substring(7);
            if (jwtUtil.validateToken(token)) {
                String username = jwtUtil.extractUsername(token);
                String role     = jwtUtil.extractRole(token);
                boolean demo    = jwtUtil.extractDemo(token);

                // role 없으면 기존 토큰 → ADMIN으로 처리 (하위 호환)
                String grantedRole = "CLIENT".equals(role) ? "ROLE_CLIENT" : "ROLE_ADMIN";

                // 데모 토큰이면 ROLE_DEMO 를 함께 부여한다. 컨트롤러가 DemoContext.isDemo()
                // 로 거래처 아이디/비번 같은 민감 정보를 응답 단계에서 가릴 수 있게 하는 표식.
                List<SimpleGrantedAuthority> authorities = new ArrayList<>();
                authorities.add(new SimpleGrantedAuthority(grantedRole));
                if (demo) authorities.add(new SimpleGrantedAuthority("ROLE_DEMO"));

                UsernamePasswordAuthenticationToken auth =
                    new UsernamePasswordAuthenticationToken(username, null, authorities);
                SecurityContextHolder.getContext().setAuthentication(auth);

                // 데모(둘러보기) 계정 — 조회(GET/HEAD/OPTIONS) 외 모든 요청을 차단한다.
                // 프론트의 fetch 가드가 1차로 막지만, 그게 뚫리거나 API 를 직접 호출해도
                // 실제 데이터는 절대 바뀌지 않도록 백엔드에서 한 번 더 못 박는다.
                if (demo && !isReadOnly(request.getMethod())) {
                    response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                    response.setContentType("application/json;charset=UTF-8");
                    response.getWriter().write(
                        "{\"demo\":true,\"message\":\"데모 계정에서는 저장·삭제 등 변경 기능을 사용할 수 없습니다.\"}");
                    return;
                }
            }
        }
        chain.doFilter(request, response);
    }

    private static boolean isReadOnly(String method) {
        return "GET".equalsIgnoreCase(method)
            || "HEAD".equalsIgnoreCase(method)
            || "OPTIONS".equalsIgnoreCase(method);
    }
}
