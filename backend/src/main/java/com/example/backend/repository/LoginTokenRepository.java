package com.example.backend.repository;

import com.example.backend.entity.ClientUser;
import com.example.backend.entity.LoginToken;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface LoginTokenRepository extends JpaRepository<LoginToken, Long> {
    Optional<LoginToken> findByToken(String token);

    @Modifying
    @Query("UPDATE LoginToken t SET t.used = true WHERE t.clientUser = :client AND t.used = false")
    void invalidateByClient(@Param("client") ClientUser client);
}
