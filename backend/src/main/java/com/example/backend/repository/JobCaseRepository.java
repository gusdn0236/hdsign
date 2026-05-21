package com.example.backend.repository;

import com.example.backend.entity.JobCase;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface JobCaseRepository extends JpaRepository<JobCase, Long> {

    // 목록 화면용 — 최신순. costs/files 두 컬렉션을 EntityGraph 로 동시에 끌어오면
    // MultipleBagFetchException 이라 client(ManyToOne)만 함께 가져오고, costs/files 는
    // 서비스 트랜잭션 안의 DTO 변환 시점에 lazy 로딩한다(사례 수가 적어 N+1 비용 미미).
    @EntityGraph(attributePaths = {"client"})
    List<JobCase> findAllByOrderByCreatedAtDesc();
}
