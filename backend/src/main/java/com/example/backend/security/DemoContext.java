package com.example.backend.security;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 현재 요청이 데모(둘러보기) 계정 토큰으로 들어왔는지 판별하는 헬퍼.
 *
 * JwtFilter 가 데모 토큰에 ROLE_DEMO 권한을 함께 부여하므로, 컨트롤러는 어디서든
 * {@link #isDemo()} 로 확인해 거래처 로그인 정보(아이디·비번) 같은 민감 정보를
 * 응답에서 가릴 수 있다. (데모는 변경이 막혀 있으므로 쓰기 경로는 신경 쓸 필요 없고,
 * 오직 조회 응답을 가리는 용도다.)
 */
public final class DemoContext {

    private DemoContext() {}

    /** 데모 화면에서 거래처 아이디·비번을 대체해 보여줄 마스킹 문자열. */
    public static final String MASK = "••••••";

    /** 현재 SecurityContext 의 인증이 데모 계정(ROLE_DEMO)이면 true. */
    public static boolean isDemo() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return false;
        return auth.getAuthorities().stream()
                .anyMatch(g -> "ROLE_DEMO".equals(g.getAuthority()));
    }
}
