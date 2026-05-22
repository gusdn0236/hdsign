package com.example.backend.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Component
public class JwtUtil {

    private final SecretKey key;
    private final long expirationMs;
    private final long clientExpirationMs;

    public JwtUtil(
            @Value("${jwt.secret}") String secret,
            @Value("${jwt.expiration-ms:86400000}") long expirationMs,
            @Value("${jwt.client-expiration-ms:2592000000}") long clientExpirationMs
    ) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.expirationMs = expirationMs;
        this.clientExpirationMs = clientExpirationMs;
    }

    public String generateAdminToken(String username) {
        return Jwts.builder()
                .subject(username)
                .claim("role", "ADMIN")
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + expirationMs))
                .signWith(key)
                .compact();
    }

    public String generateClientToken(String username) {
        return Jwts.builder()
                .subject(username)
                .claim("role", "CLIENT")
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + clientExpirationMs))
                .signWith(key)
                .compact();
    }

    public String generateToken(String username) {
        return generateAdminToken(username);
    }

    /** 데모(둘러보기) 관리자 토큰 — role 은 ADMIN 이지만 demo=true 가 박혀
     *  JwtFilter 가 GET 외 모든 요청을 403 으로 막는다. */
    public String generateDemoAdminToken(String username) {
        return generateDemoToken(username, "ADMIN", expirationMs);
    }

    /** 데모(둘러보기) 거래처 토큰 — role 은 CLIENT, demo=true. */
    public String generateDemoClientToken(String username) {
        return generateDemoToken(username, "CLIENT", clientExpirationMs);
    }

    private String generateDemoToken(String username, String role, long ttlMs) {
        return Jwts.builder()
                .subject(username)
                .claim("role", role)
                .claim("demo", true)
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + ttlMs))
                .signWith(key)
                .compact();
    }

    public String extractUsername(String token) {
        return parseClaims(token).getPayload().getSubject();
    }

    public String extractRole(String token) {
        return (String) parseClaims(token).getPayload().get("role");
    }

    /** 데모 계정 토큰이면 true. demo 클레임이 없는 일반 토큰은 false. */
    public boolean extractDemo(String token) {
        return Boolean.TRUE.equals(parseClaims(token).getPayload().get("demo"));
    }

    public boolean validateToken(String token) {
        try {
            parseClaims(token);
            return true;
        } catch (JwtException | IllegalArgumentException e) {
            return false;
        }
    }

    private Jws<Claims> parseClaims(String token) {
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token);
    }
}
