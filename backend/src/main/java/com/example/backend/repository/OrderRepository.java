package com.example.backend.repository;

import com.example.backend.entity.Order;
import com.example.backend.entity.ClientUser;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

public interface OrderRepository extends JpaRepository<Order, Long> {
    // OrderDto.toResponse() 가 client.companyName + files 목록을 모두 직렬화하므로
    // EntityGraph 로 한 쿼리에 같이 끌어와 N+1 제거. 주문이 누적될수록 효과 큼.
    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByClientAndDeletedAtIsNullOrderByCreatedAtDesc(ClientUser client);

    Optional<Order> findByOrderNumber(String orderNumber);

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNullOrderByCreatedAtDesc();

    @EntityGraph(attributePaths = {"client", "files"})
    List<Order> findByDeletedAtIsNotNullOrderByDeletedAtDesc();

    List<Order> findByDeletedAtBefore(LocalDateTime cutoff);
    long countByOrderNumberStartingWith(String prefix);
}
