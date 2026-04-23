package com.example.backend.repository;

import com.example.backend.entity.OrderFile;
import com.example.backend.entity.Order;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface OrderFileRepository extends JpaRepository<OrderFile, Long> {
    List<OrderFile> findByOrder(Order order);
}
