package com.example.backend.repository;

import com.example.backend.entity.Order;
import com.example.backend.entity.ClientUser;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;

public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByClientOrderByCreatedAtDesc(ClientUser client);
    Optional<Order> findByOrderNumber(String orderNumber);
    List<Order> findAllByOrderByCreatedAtDesc();
    long countByOrderNumberStartingWith(String prefix);
}
