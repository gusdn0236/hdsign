package com.example.backend.service;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.dto.OrderDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.Order.DeliveryMethod;
import com.example.backend.entity.Order.OrderStatus;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.OrderRepository;
import com.example.backend.security.JwtUtil;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ClientService {

    private final ClientUserRepository clientUserRepository;
    private final OrderRepository orderRepository;
    private final JwtUtil jwtUtil;
    private final PasswordEncoder passwordEncoder;
    private final OrderMailService orderMailService;

    // ── 로그인 ──
    public ClientAuthDto.LoginResponse login(String username, String password) {
        ClientUser user = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다."));

        if (!user.getIsActive())
            throw new RuntimeException("비활성화된 계정입니다. 담당자에게 문의해주세요.");

        if (!passwordEncoder.matches(password, user.getPassword()))
            throw new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다.");

        String token = jwtUtil.generateClientToken(username);
        return new ClientAuthDto.LoginResponse(token, user.getCompanyName(), user.getContactName(), username);
    }

    // ── 작업 요청 접수 ──
    @Transactional
    public OrderDto.Response submitOrder(
            String username,
            String title,
            String additionalItems,
            String note,
            String dueDate,
            String dueTime,
            String deliveryMethod,
            String deliveryAddress,
            List<MultipartFile> files
    ) {
        ClientUser client = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("거래처 정보를 찾을 수 없습니다."));

        String orderNumber = generateOrderNumber();
        boolean hasSMPS = additionalItems != null && additionalItems.contains("파워기(SMPS)");

        Order order = Order.builder()
                .orderNumber(orderNumber)
                .client(client)
                .title(title)
                .hasSMPS(hasSMPS)
                .additionalItems(additionalItems)
                .note(note)
                .dueDate(LocalDate.parse(dueDate))
                .dueTime(dueTime)
                .deliveryMethod(DeliveryMethod.valueOf(deliveryMethod))
                .deliveryAddress(deliveryAddress)
                .status(OrderStatus.RECEIVED)
                .build();

        Order saved = orderRepository.save(order);
        orderMailService.sendOrderMail(saved, client, files);

        return OrderDto.toResponse(saved);
    }


    // ── 내 작업 목록 조회 ──
    @Transactional(readOnly = true)
    public List<OrderDto.Response> getMyOrders(String username) {
        ClientUser client = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("거래처 정보를 찾을 수 없습니다."));
        return orderRepository.findByClientOrderByCreatedAtDesc(client)
                .stream().map(OrderDto::toResponse).toList();
    }

    // ── 주문번호 생성 (ORD-20250422-001) ──
    private String generateOrderNumber() {
        String date = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        long count = orderRepository.count() + 1;
        return String.format("ORD-%s-%03d", date, count);
    }
}
