package com.example.backend.service;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.dto.OrderDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.Order.DeliveryMethod;
import com.example.backend.entity.Order.OrderStatus;
import com.example.backend.entity.OrderFile;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.OrderFileRepository;
import com.example.backend.repository.OrderRepository;
import com.example.backend.security.JwtUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class ClientService {

    private final ClientUserRepository clientUserRepository;
    private final OrderRepository       orderRepository;
    private final OrderFileRepository   orderFileRepository;
    private final JwtUtil               jwtUtil;
    private final PasswordEncoder       passwordEncoder;
    private final S3Client              s3Client;
    private final MailService           mailService;

    @Value("${r2.bucket}")      private String bucket;
    @Value("${r2.public-url}") private String publicUrl;

    // ── 로그인 ────────────────────────────────────────────────────────
    public ClientAuthDto.LoginResponse login(String username, String password) {
        ClientUser user = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다."));
        if (!user.getIsActive())
            throw new RuntimeException("비활성화된 계정입니다. 담당자에게 문의해주세요.");
        if (!passwordEncoder.matches(password, user.getPassword()))
            throw new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다.");

        return new ClientAuthDto.LoginResponse(
                jwtUtil.generateClientToken(username),
                user.getCompanyName(), user.getContactName(), username);
    }

    // ── 작업 요청 접수 ────────────────────────────────────────────────
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

        Order order = Order.builder()
                .orderNumber(orderNumber)
                .client(client)
                .title(title)
                .hasSMPS(additionalItems != null && additionalItems.contains("파워기(SMPS)"))
                .additionalItems(additionalItems)
                .note(note)
                .dueDate(LocalDate.parse(dueDate))
                .dueTime(dueTime)
                .deliveryMethod(DeliveryMethod.valueOf(deliveryMethod))
                .deliveryAddress(deliveryAddress)
                .status(OrderStatus.RECEIVED)
                .build();

        Order saved = orderRepository.save(order);

        // ── 파일 R2 업로드 & OrderFile 저장 ──
        List<MultipartFile> uploadedFiles = new ArrayList<>();
        if (files != null) {
            for (MultipartFile file : files) {
                if (file == null || file.isEmpty()) continue;
                try {
                    String fname = file.getOriginalFilename() != null
                            ? file.getOriginalFilename() : "unknown";
                    String ext = fname.contains(".")
                            ? fname.substring(fname.lastIndexOf(".")) : "";
                    String key = "orders/" + orderNumber + "/" + UUID.randomUUID() + ext;

                    s3Client.putObject(
                            PutObjectRequest.builder()
                                    .bucket(bucket).key(key)
                                    .contentType(file.getContentType())
                                    .build(),
                            RequestBody.fromBytes(file.getBytes()));

                    String fileUrl = (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/") + key;
                    OrderFile of = OrderFile.builder()
                            .order(saved)
                            .originalName(fname)
                            .storedName(key)
                            .fileUrl(fileUrl)
                            .fileSize(file.getSize())
                            .contentType(file.getContentType())
                            .build();
                    orderFileRepository.save(of);
                    saved.getFiles().add(of);
                    uploadedFiles.add(file);

                } catch (Exception e) {
                    log.warn("R2 파일 업로드 실패 [{}]: {}", file.getOriginalFilename(), e.getMessage());
                    uploadedFiles.add(file); // 실패해도 메일에는 포함
                }
            }
        }

        // ── 알림 메일 발송 (실패해도 주문 처리에 영향 없음) ──
        try {
            mailService.sendOrderNotification(saved, uploadedFiles);
        } catch (Exception e) {
            log.error("메일 발송 호출 실패: {}", e.getMessage());
        }

        return OrderDto.toResponse(saved);
    }

    // ── 내 주문 목록 ──────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<OrderDto.Response> getMyOrders(String username) {
        ClientUser client = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("거래처 정보를 찾을 수 없습니다."));
        return orderRepository.findByClientOrderByCreatedAtDesc(client)
                .stream().map(OrderDto::toResponse).toList();
    }

    // ── 주문번호 생성 ──────────────────────────────────────────────────
    private String generateOrderNumber() {
        String date = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        long count = orderRepository.count() + 1;
        return String.format("ORD-%s-%03d", date, count);
    }
}
