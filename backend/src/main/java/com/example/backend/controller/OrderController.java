package com.example.backend.controller;

import com.example.backend.dto.OrderDto;
import com.example.backend.service.ClientService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.security.Principal;
import java.util.List;

@RestController
@RequestMapping("/api/client/orders")
@RequiredArgsConstructor
public class OrderController {

    private final ClientService clientService;

    // 작업 요청 접수
    @PostMapping
    public ResponseEntity<OrderDto.Response> submit(
            Principal principal,
            @RequestParam(required = false) String title,
            @RequestParam(required = false) String additionalItems,
            @RequestParam(required = false) String note,
            @RequestParam String dueDate,
            @RequestParam(required = false) String dueTime,
            @RequestParam String deliveryMethod,
            @RequestParam(required = false) String deliveryAddress,
            @RequestParam(required = false) List<MultipartFile> files
    ) {
        OrderDto.Response res = clientService.submitOrder(
                principal.getName(), title, additionalItems, note,
                dueDate, dueTime, deliveryMethod, deliveryAddress, files
        );
        return ResponseEntity.ok(res);
    }

    // 내 작업 목록 조회
    @GetMapping
    public ResponseEntity<List<OrderDto.Response>> getMyOrders(Principal principal) {
        return ResponseEntity.ok(clientService.getMyOrders(principal.getName()));
    }
}
