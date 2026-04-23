package com.example.backend.repository;

import com.example.backend.entity.ClientUser;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;

public interface ClientUserRepository extends JpaRepository<ClientUser, Long> {
    Optional<ClientUser> findByUsername(String username);
    Optional<ClientUser> findByEmail(String email);
    boolean existsByUsername(String username);
    List<ClientUser> findAllByOrderByCreatedAtDesc();
}
