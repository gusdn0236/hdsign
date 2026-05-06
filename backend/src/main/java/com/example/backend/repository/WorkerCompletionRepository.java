package com.example.backend.repository;

import com.example.backend.entity.WorkerCompletion;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface WorkerCompletionRepository extends JpaRepository<WorkerCompletion, Long> {
    Optional<WorkerCompletion> findByOrder_IdAndWorker(Long orderId, String worker);
}
