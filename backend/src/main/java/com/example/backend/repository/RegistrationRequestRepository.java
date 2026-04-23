package com.example.backend.repository;

import com.example.backend.entity.RegistrationRequest;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface RegistrationRequestRepository extends JpaRepository<RegistrationRequest, Long> {
    Optional<RegistrationRequest> findByEmailAndStatus(String email, RegistrationRequest.RequestStatus status);
    List<RegistrationRequest> findByStatusOrderByCreatedAtAsc(RegistrationRequest.RequestStatus status);
}
