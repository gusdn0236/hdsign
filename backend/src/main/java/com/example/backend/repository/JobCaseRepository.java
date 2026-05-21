package com.example.backend.repository;

import com.example.backend.entity.JobCase;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface JobCaseRepository extends JpaRepository<JobCase, Long> {

    // 목록 화면용 — 최신순. client(ManyToOne) + costs(컬렉션 1개)만 함께 끌어오므로
    // MultipleBagFetchException 없이 안전하다.
    @EntityGraph(attributePaths = {"client", "costs"})
    List<JobCase> findAllByOrderByCreatedAtDesc();
}
