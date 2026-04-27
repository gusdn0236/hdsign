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
import com.example.backend.util.HangulSimilarity;
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

import java.text.Normalizer;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
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

        // status 별 메시지 차별화 — 가입 흐름 단계에서 거래처가 자기 상태를 알 수 있게.
        String status = user.getStatus();
        if ("PENDING_APPROVAL".equals(status)) {
            throw new RuntimeException("가입 신청 후 관리자 승인 대기 중입니다. 사무실로 문의해주세요.");
        }
        if ("PENDING_SIGNUP".equals(status)) {
            // 이 상태로 로그인 시도가 들어오는 건 비정상 — username 이 비어있어 위 findByUsername 에서 못 찾음.
            // 방어적으로만 처리.
            throw new RuntimeException("아직 가입이 완료되지 않은 계정입니다.");
        }
        if (!"ACTIVE".equals(status) || !user.getIsActive()) {
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

    /** 가입 검색 — PENDING_SIGNUP 행만 대상.
     *  1단계 정확일치 (companyName/networkFolderName/aliases 정규화 일치 OR 이메일 일치) → 그것만 반환.
     *  정확일치가 없으면 2단계 자모 유사도 후보 최대 5개.
     *  이메일성 쿼리(@ 포함)는 정확일치만, 유사도 단계는 건너뜀 — 이메일은 오타 허용 위험 큼. */
    @Transactional(readOnly = true)
    public ClientAuthDto.SignupSearchResponse signupSearch(String query) {
        if (query == null || query.isBlank())
            return new ClientAuthDto.SignupSearchResponse(List.of(), false);
        String trimmed = query.trim();
        String byName = normalizeKey(trimmed);
        String byEmail = trimmed.toLowerCase();
        boolean emailQuery = trimmed.contains("@");

        List<ClientUser> pending = new ArrayList<>();
        for (ClientUser u : clientUserRepository.findAll()) {
            if ("PENDING_SIGNUP".equals(u.getStatus())) pending.add(u);
        }

        // 1단계: 정확일치
        List<ClientAuthDto.SignupSearchMatch> exact = new ArrayList<>();
        for (ClientUser u : pending) {
            if (matchesExact(u, byName, byEmail)) {
                exact.add(toMatch(u));
            }
        }
        if (!exact.isEmpty() || emailQuery) {
            return new ClientAuthDto.SignupSearchResponse(exact, true);
        }

        // 2단계: 자모 유사도 — 후보별 최저 거리/비율 계산 후 상위 5개.
        // 후보 텍스트 = companyName + networkFolderName + aliases 토큰들.
        List<Scored> scored = new ArrayList<>();
        for (ClientUser u : pending) {
            double bestRatio = 1.0;
            int bestDist = Integer.MAX_VALUE;
            boolean anyContains = false;
            for (String cand : candidatesOf(u)) {
                if (cand == null || cand.isBlank()) continue;
                int d = HangulSimilarity.jamoDistance(trimmed, cand);
                double r = HangulSimilarity.similarityRatio(trimmed, cand);
                if (d < bestDist) bestDist = d;
                if (r < bestRatio) bestRatio = r;
                if (HangulSimilarity.containsAsJamo(trimmed, cand)) anyContains = true;
            }
            // 통과 조건: 자모거리 ≤ 3 OR 비율 ≤ 0.4 OR 4자모 이상 substring 일치
            if (bestDist <= 3 || bestRatio <= 0.4 || anyContains) {
                scored.add(new Scored(u, bestRatio, bestDist));
            }
        }
        scored.sort(Comparator.<Scored>comparingDouble(s -> s.ratio).thenComparingInt(s -> s.dist));

        List<ClientAuthDto.SignupSearchMatch> fuzzy = new ArrayList<>();
        for (int i = 0; i < Math.min(5, scored.size()); i++) {
            fuzzy.add(toMatch(scored.get(i).user));
        }
        return new ClientAuthDto.SignupSearchResponse(fuzzy, false);
    }

    private boolean matchesExact(ClientUser u, String byNameNormalized, String byEmailLower) {
        if (u.getCompanyName() != null && normalizeKey(u.getCompanyName()).equals(byNameNormalized)) return true;
        if (u.getNetworkFolderName() != null && !u.getNetworkFolderName().isBlank()
                && normalizeKey(u.getNetworkFolderName()).equals(byNameNormalized)) return true;
        if (u.getEmail() != null && !u.getEmail().isBlank()
                && u.getEmail().equalsIgnoreCase(byEmailLower)) return true;
        // 별칭 토큰 중 하나라도 정확일치
        for (String alias : splitAliases(u.getAliases())) {
            if (normalizeKey(alias).equals(byNameNormalized)) return true;
        }
        return false;
    }

    private List<String> candidatesOf(ClientUser u) {
        List<String> list = new ArrayList<>();
        if (u.getCompanyName() != null) list.add(u.getCompanyName());
        if (u.getNetworkFolderName() != null && !u.getNetworkFolderName().isBlank())
            list.add(u.getNetworkFolderName());
        list.addAll(splitAliases(u.getAliases()));
        return list;
    }

    private static List<String> splitAliases(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        List<String> out = new ArrayList<>();
        for (String t : raw.split("[,;\\n]+")) {
            String s = t.trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    private ClientAuthDto.SignupSearchMatch toMatch(ClientUser u) {
        return new ClientAuthDto.SignupSearchMatch(
                u.getId(),
                u.getCompanyName(),
                maskEmail(u.getEmail())
        );
    }

    private static final class Scored {
        final ClientUser user;
        final double ratio;
        final int dist;
        Scored(ClientUser u, double r, int d) { this.user = u; this.ratio = r; this.dist = d; }
    }

    /** 가입 신청 — 검색 단계에서 받은 id 에 신청 정보 박고 PENDING_APPROVAL 전환.
     *  방어: id 가 PENDING_SIGNUP 이 아니면 거부, username 중복도 거부. */
    @Transactional
    public void submitSignup(ClientAuthDto.SignupRequest req) {
        if (req.getId() == null) throw new IllegalArgumentException("거래처 식별 정보가 없습니다.");
        if (req.getUsername() == null || req.getUsername().isBlank())
            throw new IllegalArgumentException("아이디를 입력해주세요.");
        if (req.getPhone() == null || req.getPhone().isBlank())
            throw new IllegalArgumentException("전화번호를 입력해주세요.");

        ClientUser user = clientUserRepository.findById(req.getId())
                .orElseThrow(() -> new IllegalArgumentException("거래처 정보를 찾을 수 없습니다."));
        if (!"PENDING_SIGNUP".equals(user.getStatus()))
            throw new IllegalArgumentException("이미 가입 신청 중이거나 활성 계정입니다.");

        String username = req.getUsername().trim();
        if (clientUserRepository.existsByUsername(username))
            throw new IllegalArgumentException("이미 사용 중인 아이디입니다. 다른 아이디로 신청해주세요.");

        user.setUsername(username);
        user.setPhone(req.getPhone().trim());
        if (req.getEmail() != null && !req.getEmail().isBlank()) {
            String normalizedEmail = req.getEmail().trim().toLowerCase();
            // 이메일 중복 — 이미 다른 거래처가 등록한 이메일이면 거부.
            clientUserRepository.findByEmail(normalizedEmail).ifPresent(existing -> {
                if (!existing.getId().equals(user.getId()))
                    throw new IllegalArgumentException("이미 등록된 이메일입니다.");
            });
            user.setEmail(normalizedEmail);
        }
        user.setStatus("PENDING_APPROVAL");
        user.setSignupRequestedAt(LocalDateTime.now());
        clientUserRepository.save(user);
    }

    private static String normalizeKey(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s, Normalizer.Form.NFC);
        StringBuilder sb = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (!Character.isWhitespace(c)) sb.append(c);
        }
        return sb.toString().toLowerCase();
    }

    private static String maskEmail(String email) {
        if (email == null || email.isBlank()) return null;
        int at = email.indexOf('@');
        if (at <= 1) return email; // 너무 짧으면 그대로
        String local = email.substring(0, at);
        String domain = email.substring(at);
        // 앞 2글자만 노출, 나머지는 *
        return local.substring(0, Math.min(2, local.length())) + "***" + domain;
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
