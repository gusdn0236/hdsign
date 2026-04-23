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

    public String extractUsername(String token) {
        return parseClaims(token).getPayload().getSubject();
    }

    public String extractRole(String token) {
        return (String) parseClaims(token).getPayload().get("role");
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
