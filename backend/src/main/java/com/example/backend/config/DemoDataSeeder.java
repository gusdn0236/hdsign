package com.example.backend.config;

import com.example.backend.entity.Admin;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import com.example.backend.entity.Order.DeliveryMethod;
import com.example.backend.entity.Order.OrderStatus;
import com.example.backend.entity.Order.RequestType;
import com.example.backend.repository.AdminRepository;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.time.LocalDate;

/**
 * 데모(둘러보기) 계정 시더.
 *
 * 부팅 시 다음을 보장한다 — 모두 idempotent(이미 있으면 갱신만):
 *   - 데모 관리자 계정 (admins)        → /admin/login 에서 둘러보기용
 *   - 데모 거래처 계정 (client_users)  → /client/login 에서 둘러보기용
 *   - 데모 거래처용 예시 발주 3건       → 거래처 [작업 현황] 페이지가 비지 않도록
 *
 * 두 계정 모두 로그인 시 demo=true 토큰을 받아, JwtFilter 가 GET 외 모든 요청을
 * 403 으로 막는다(둘러보기 전용). 비밀번호는 application.properties 의
 * demo.* 값(환경변수 DEMO_*_PASSWORD 로 교체 가능)을 매 부팅마다 다시 반영한다.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DemoDataSeeder implements CommandLineRunner {

    private static final String DEMO_ORDER_PREFIX = "데모-";

    private final AdminRepository adminRepository;
    private final ClientUserRepository clientUserRepository;
    private final OrderRepository orderRepository;
    private final PasswordEncoder passwordEncoder;

    @Value("${demo.admin.username:demo}")  private String demoAdminUsername;
    @Value("${demo.admin.password:1234}")  private String demoAdminPassword;
    @Value("${demo.client.username:demo}") private String demoClientUsername;
    @Value("${demo.client.password:1234}") private String demoClientPassword;

    @Override
    public void run(String... args) {
        try {
            seedDemoAdmin();
            ClientUser demoClient = seedDemoClient();
            seedDemoOrders(demoClient);
        } catch (Exception e) {
            // 시드 실패가 앱 기동을 막지 않도록 방어 — 데모만 못 쓰고 본 기능은 정상.
            log.warn("데모 계정 시드 실패 (앱 동작에는 영향 없음): {}", e.getMessage());
        }
    }

    /** 데모 관리자 — 없으면 생성, 있으면 비밀번호/이름 동기화. */
    private void seedDemoAdmin() {
        Admin admin = adminRepository.findByUsername(demoAdminUsername).orElseGet(Admin::new);
        admin.setUsername(demoAdminUsername);
        admin.setName("데모 관리자");
        admin.setPassword(passwordEncoder.encode(demoAdminPassword));
        adminRepository.save(admin);
        log.info("데모 관리자 계정 준비 완료 — username={}", demoAdminUsername);
    }

    /** 데모 거래처 — 없으면 생성, 있으면 비밀번호 등 동기화. */
    private ClientUser seedDemoClient() {
        ClientUser client = clientUserRepository.findByUsername(demoClientUsername).orElseGet(ClientUser::new);
        client.setUsername(demoClientUsername);
        client.setPassword(passwordEncoder.encode(demoClientPassword));
        client.setPasswordPlaintext(demoClientPassword);
        client.setCompanyName("데모 거래처 (체험용)");
        client.setContactName("데모 담당자");
        client.setPhone("010-0000-0000");
        if (client.getEmail() == null || client.getEmail().isBlank()) {
            client.setEmail("demo@hdsigncraft.com");
        }
        client.setStatus("ACTIVE");
        client.setIsActive(true);
        ClientUser saved = clientUserRepository.save(client);
        log.info("데모 거래처 계정 준비 완료 — username={}", demoClientUsername);
        return saved;
    }

    /** 데모 거래처 [작업 현황] 페이지가 비어 보이지 않도록 예시 발주를 한 번만 채운다. */
    private void seedDemoOrders(ClientUser demoClient) {
        if (!orderRepository.findByOrderNumberStartingWith(DEMO_ORDER_PREFIX).isEmpty()) {
            return; // 이미 시드됨
        }
        LocalDate today = LocalDate.now();

        orderRepository.save(Order.builder()
                .orderNumber(DEMO_ORDER_PREFIX + "001")
                .requestType(RequestType.ORDER)
                .client(demoClient)
                .title("아크릴 입체 간판 제작 의뢰")
                .status(OrderStatus.RECEIVED)
                .note("데모용 예시 발주입니다. 실제 발주가 아닙니다.")
                .build());

        orderRepository.save(Order.builder()
                .orderNumber(DEMO_ORDER_PREFIX + "002")
                .requestType(RequestType.ORDER)
                .client(demoClient)
                .title("LED 채널 사인 5개 세트")
                .status(OrderStatus.IN_PROGRESS)
                .dueDate(today.plusDays(5))
                .deliveryMethod(DeliveryMethod.CARGO)
                .note("데모용 예시 발주입니다. 실제 발주가 아닙니다.")
                .build());

        orderRepository.save(Order.builder()
                .orderNumber(DEMO_ORDER_PREFIX + "003")
                .requestType(RequestType.ORDER)
                .client(demoClient)
                .title("스테인리스 도금 사인 시공")
                .status(OrderStatus.COMPLETED)
                .deliveryMethod(DeliveryMethod.PICKUP)
                .note("데모용 예시 발주입니다. 실제 발주가 아닙니다.")
                .build());

        log.info("데모 거래처 예시 발주 3건 생성 완료");
    }
}
