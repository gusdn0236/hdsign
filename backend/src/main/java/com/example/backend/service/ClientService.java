package com.example.backend.service;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.dto.OrderDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.Order.DeliveryMethod;
import com.example.backend.entity.Order.OrderStatus;
import com.example.backend.entity.Order.RequestType;
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
    private final OrderRepository orderRepository;
    private final OrderFileRepository orderFileRepository;
    private final JwtUtil jwtUtil;
    private final PasswordEncoder passwordEncoder;
    private final S3Client s3Client;
    private final MailService mailService;

    @Value("${r2.bucket}")
    private String bucket;

    @Value("${r2.public-url}")
    private String publicUrl;

    public ClientAuthDto.LoginResponse login(String username, String password) {
        ClientUser user = clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다."));

        if (!user.getIsActive()) {
            throw new RuntimeException("비활성화된 계정입니다. 담당자에게 문의해주세요.");
        }
        if (!passwordEncoder.matches(password, user.getPassword())) {
            throw new RuntimeException("아이디 또는 비밀번호가 올바르지 않습니다.");
        }

        return new ClientAuthDto.LoginResponse(
                jwtUtil.generateClientToken(username),
                user.getCompanyName(),
                user.getContactName(),
                username
        );
    }

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
        ClientUser client = findClient(username);
        String orderNumber = generateOrderNumber(RequestType.ORDER);

        Order order = Order.builder()
                .orderNumber(orderNumber)
                .requestType(RequestType.ORDER)
                .client(client)
                .title(title)
                .hasSMPS(additionalItems != null && additionalItems.contains("SMPS"))
                .additionalItems(additionalItems)
                .note(note)
                .dueDate(LocalDate.parse(dueDate))
                .dueTime(dueTime)
                .deliveryMethod(DeliveryMethod.valueOf(deliveryMethod))
                .deliveryAddress(deliveryAddress)
                .status(OrderStatus.RECEIVED)
                .build();

        return saveRequest(order, client, files);
    }

    @Transactional
    public OrderDto.Response submitQuoteRequest(
            String username,
            String title,
            String note,
            List<MultipartFile> files
    ) {
        ClientUser client = findClient(username);
        String orderNumber = generateOrderNumber(RequestType.QUOTE);

        Order order = Order.builder()
                .orderNumber(orderNumber)
                .requestType(RequestType.QUOTE)
                .client(client)
                .title(title)
                .hasSMPS(false)
                .additionalItems(null)
                .note(note)
                .dueDate(null)
                .dueTime(null)
                .deliveryMethod(null)
                .deliveryAddress(null)
                .status(OrderStatus.RECEIVED)
                .build();

        return saveRequest(order, client, files);
    }

    @Transactional(readOnly = true)
    public List<OrderDto.Response> getMyOrders(String username) {
        ClientUser client = findClient(username);
        return orderRepository.findByClientAndDeletedAtIsNullOrderByCreatedAtDesc(client)
                .stream()
                .map(OrderDto::toResponse)
                .toList();
    }

    private ClientUser findClient(String username) {
        return clientUserRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("거래처 정보를 찾을 수 없습니다."));
    }

    private OrderDto.Response saveRequest(Order order, ClientUser client, List<MultipartFile> files) {
        Order saved = orderRepository.save(order);
        List<MultipartFile> uploadedFiles = uploadFiles(saved, files);

        try {
            mailService.sendOrderNotification(buildOrderNotification(saved, client), uploadedFiles);
        } catch (Exception e) {
            log.error("메일 발송 호출 실패: {}", e.getMessage());
        }

        return OrderDto.toResponse(saved);
    }

    private List<MultipartFile> uploadFiles(Order saved, List<MultipartFile> files) {
        List<MultipartFile> uploadedFiles = new ArrayList<>();
        if (files == null) {
            return uploadedFiles;
        }

        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) {
                continue;
            }

            try {
                String originalName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "unknown";
                String extension = originalName.contains(".")
                        ? originalName.substring(originalName.lastIndexOf("."))
                        : "";
                String key = "orders/" + saved.getOrderNumber() + "/" + UUID.randomUUID() + extension;

                s3Client.putObject(
                        PutObjectRequest.builder()
                                .bucket(bucket)
                                .key(key)
                                .contentType(file.getContentType())
                                .build(),
                        RequestBody.fromBytes(file.getBytes())
                );

                String normalizedPublicUrl = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
                String fileUrl = normalizedPublicUrl + key;

                OrderFile orderFile = OrderFile.builder()
                        .order(saved)
                        .originalName(originalName)
                        .storedName(key)
                        .fileUrl(fileUrl)
                        .fileSize(file.getSize())
                        .contentType(file.getContentType())
                        .build();

                orderFileRepository.save(orderFile);
                saved.getFiles().add(orderFile);
                uploadedFiles.add(file);
            } catch (Exception e) {
                log.warn("R2 파일 업로드 실패 [{}]: {}", file.getOriginalFilename(), e.getMessage());
                uploadedFiles.add(file);
            }
        }

        return uploadedFiles;
    }

    private String generateOrderNumber(RequestType requestType) {
        String date = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyMMdd"));
        String prefix = (requestType == RequestType.QUOTE ? "견적-" : "주문-") + date + "-";
        long count = orderRepository.countByOrderNumberStartingWith(prefix) + 1;
        return String.format("%s%02d", prefix, count);
    }

    private MailService.OrderNotification buildOrderNotification(Order order, ClientUser client) {
        List<MailService.StoredFileLink> storedFiles = order.getFiles().stream()
                .map(file -> new MailService.StoredFileLink(file.getOriginalName(), file.getFileUrl()))
                .toList();

        return new MailService.OrderNotification(
                order.getOrderNumber(),
                order.getRequestType().name(),
                requestTypeLabel(order.getRequestType()),
                order.getCreatedAt(),
                client.getCompanyName(),
                client.getContactName(),
                client.getPhone(),
                order.getTitle(),
                order.getAdditionalItems(),
                order.getNote(),
                order.getDueDate(),
                order.getDueTime(),
                deliveryMethodLabel(order.getDeliveryMethod()),
                order.getDeliveryAddress(),
                storedFiles
        );
    }

    private String requestTypeLabel(RequestType requestType) {
        return requestType == RequestType.QUOTE ? "견적 요청" : "작업 요청";
    }

    private String deliveryMethodLabel(DeliveryMethod deliveryMethod) {
        if (deliveryMethod == null) {
            return null;
        }
        return switch (deliveryMethod) {
            case CARGO -> "화물 발송";
            case QUICK -> "퀵 발송";
            case DIRECT -> "직접 배송";
            case PICKUP -> "직접 수령";
            case LOCAL_CARGO -> "지방화물차 배송";
        };
    }
}
