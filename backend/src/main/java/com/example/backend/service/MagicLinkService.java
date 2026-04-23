package com.example.backend.service;

import com.example.backend.dto.ClientAuthDto;
import com.example.backend.dto.RegistrationRequestDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.entity.LoginToken;
import com.example.backend.entity.RegistrationRequest;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.LoginTokenRepository;
import com.example.backend.repository.RegistrationRequestRepository;
import com.example.backend.security.JwtUtil;
import jakarta.mail.internet.MimeMessage;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class MagicLinkService {

    public enum RegistrationRequestResult {
        CREATED,
        ALREADY_PENDING,
        ALREADY_REGISTERED
    }

    private static final String MSG_INVALID_LINK = "유효하지 않은 링크입니다.";
    private static final String MSG_USED_LINK = "이미 사용된 링크입니다. 새로운 링크를 요청해주세요.";
    private static final String MSG_EXPIRED_LINK = "만료된 링크입니다. 새로운 링크를 요청해주세요.";
    private static final String MSG_INACTIVE_ACCOUNT = "비활성화된 계정입니다. 관리자에게 문의해주세요.";
    private static final String MSG_DUPLICATE_EMAIL = "이미 등록된 이메일입니다.";
    private static final String MSG_REQUEST_NOT_FOUND = "신청 내역을 찾을 수 없습니다.";
    private static final String MSG_REQUEST_ALREADY_PROCESSED = "이미 처리된 신청입니다.";
    private static final String MSG_MAIL_NOT_CONFIGURED = "메일 발송 설정이 완료되지 않았습니다. 관리자에게 문의해주세요.";
    private static final String MSG_MAIL_SEND_FAILED = "메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.";

    private final ClientUserRepository clientUserRepository;
    private final LoginTokenRepository loginTokenRepository;
    private final RegistrationRequestRepository registrationRequestRepository;
    private final JavaMailSender mailSender;
    private final JwtUtil jwtUtil;
    private final PasswordEncoder passwordEncoder;

    @Value("${magic.link.base-url:https://gusdn0236.github.io/hdsign}")
    private String configuredBaseUrl;

    @Value("${spring.mail.username:}")
    private String mailFrom;

    @Value("${spring.mail.password:}")
    private String mailPassword;

    @Value("${spring.mail.host:}")
    private String mailHost;

    @Value("${order.mail.to:}")
    private String adminReceiver;

    @Transactional
    public void sendMagicLink(String email, String requestedBaseUrl) {
        Optional<ClientUser> optUser = clientUserRepository.findByEmail(normalizeEmail(email));
        if (optUser.isEmpty() || !Boolean.TRUE.equals(optUser.get().getIsActive())) {
            return;
        }

        ClientUser user = optUser.get();
        loginTokenRepository.invalidateByClient(user);

        String token = saveToken(user, 10);
        String link = buildVerifyLink(resolveFrontendBaseUrl(requestedBaseUrl), token);
        sendEmail(
                user.getEmail(),
                "[HD Sign] 로그인 링크가 도착했습니다",
                buildLoginBody(user.getCompanyName(), link, 10)
        );
    }

    @Transactional
    public ClientAuthDto.LoginResponse verifyMagicLink(String token) {
        LoginToken loginToken = loginTokenRepository.findByToken(token)
                .orElseThrow(() -> new IllegalArgumentException(MSG_INVALID_LINK));

        if (Boolean.TRUE.equals(loginToken.getUsed())) {
            throw new IllegalArgumentException(MSG_USED_LINK);
        }
        if (loginToken.getExpiresAt().isBefore(LocalDateTime.now())) {
            throw new IllegalArgumentException(MSG_EXPIRED_LINK);
        }

        ClientUser user = loginToken.getClientUser();
        if (!Boolean.TRUE.equals(user.getIsActive())) {
            throw new IllegalArgumentException(MSG_INACTIVE_ACCOUNT);
        }

        loginToken.setUsed(true);

        String jwt = jwtUtil.generateClientToken(user.getUsername());
        return new ClientAuthDto.LoginResponse(
                jwt,
                user.getCompanyName(),
                user.getContactName(),
                user.getUsername()
        );
    }

    @Transactional
    public RegistrationRequestResult requestRegistration(
            String email,
            String companyName,
            String contactName,
            String phone,
            String requestedBaseUrl
    ) {
        String normalizedEmail = normalizeEmail(email);
        String normalizedCompanyName = normalizeText(companyName);
        String normalizedContactName = normalizeText(contactName);
        String normalizedPhone = normalizeText(phone);
        String frontendBaseUrl = resolveFrontendBaseUrl(requestedBaseUrl);

        Optional<ClientUser> existingUser = clientUserRepository.findByEmail(normalizedEmail);
        if (existingUser.isPresent()) {
            sendMagicLink(normalizedEmail, frontendBaseUrl);
            return RegistrationRequestResult.ALREADY_REGISTERED;
        }

        Optional<RegistrationRequest> pendingRequest =
                registrationRequestRepository.findByEmailAndStatus(
                        normalizedEmail,
                        RegistrationRequest.RequestStatus.PENDING
                );
        if (pendingRequest.isPresent()) {
            sendEmail(
                    normalizedEmail,
                    "[HD Sign] 가입 신청이 접수된 상태입니다",
                    buildRegistrationReceivedBody(normalizedCompanyName, normalizedContactName, normalizedPhone, false)
            );
            return RegistrationRequestResult.ALREADY_PENDING;
        }

        registrationRequestRepository.save(
                RegistrationRequest.builder()
                        .email(normalizedEmail)
                        .companyName(normalizedCompanyName)
                        .contactName(normalizedContactName)
                        .phone(normalizedPhone)
                        .build()
        );

        sendEmail(
                normalizedEmail,
                "[HD Sign] 가입 신청이 접수되었습니다",
                buildRegistrationReceivedBody(normalizedCompanyName, normalizedContactName, normalizedPhone, true)
        );
        sendRegistrationNotificationToAdmin(
                normalizedEmail,
                normalizedCompanyName,
                normalizedContactName,
                normalizedPhone,
                frontendBaseUrl
        );
        return RegistrationRequestResult.CREATED;
    }

    @Transactional(readOnly = true)
    public List<RegistrationRequestDto.Response> getPendingRegistrations() {
        return registrationRequestRepository
                .findByStatusOrderByCreatedAtAsc(RegistrationRequest.RequestStatus.PENDING)
                .stream()
                .map(request -> new RegistrationRequestDto.Response(
                        request.getId(),
                        request.getEmail(),
                        request.getCompanyName(),
                        request.getContactName(),
                        request.getPhone(),
                        request.getStatus().name(),
                        request.getCreatedAt() != null ? request.getCreatedAt().toString() : null
                ))
                .toList();
    }

    @Transactional
    public void approveRegistration(Long id, String requestedBaseUrl) {
        RegistrationRequest request = findPendingOrThrow(id);

        if (clientUserRepository.findByEmail(request.getEmail()).isPresent()) {
            throw new IllegalArgumentException(MSG_DUPLICATE_EMAIL);
        }

        ClientUser user = clientUserRepository.save(
                ClientUser.builder()
                        .username(generateUsername(request.getEmail()))
                        .password(passwordEncoder.encode(UUID.randomUUID().toString()))
                        .companyName(request.getCompanyName())
                        .contactName(request.getContactName())
                        .phone(request.getPhone())
                        .email(request.getEmail())
                        .isActive(true)
                        .build()
        );

        request.setStatus(RegistrationRequest.RequestStatus.APPROVED);
        request.setProcessedAt(LocalDateTime.now());

        loginTokenRepository.invalidateByClient(user);
        String token = saveToken(user, 24 * 60);
        String link = buildVerifyLink(resolveFrontendBaseUrl(requestedBaseUrl), token);

        sendEmail(
                user.getEmail(),
                "[HD Sign] 거래처 포털 가입이 승인되었습니다",
                buildApprovalBody(user.getCompanyName(), link)
        );
    }

    @Transactional
    public void rejectRegistration(Long id) {
        RegistrationRequest request = findPendingOrThrow(id);
        request.setStatus(RegistrationRequest.RequestStatus.REJECTED);
        request.setProcessedAt(LocalDateTime.now());
    }

    private RegistrationRequest findPendingOrThrow(Long id) {
        RegistrationRequest request = registrationRequestRepository.findById(id)
                .orElseThrow(() -> new RuntimeException(MSG_REQUEST_NOT_FOUND));

        if (request.getStatus() != RegistrationRequest.RequestStatus.PENDING) {
            throw new IllegalArgumentException(MSG_REQUEST_ALREADY_PROCESSED);
        }
        return request;
    }

    private String saveToken(ClientUser user, long validMinutes) {
        LoginToken token = loginTokenRepository.save(
                LoginToken.builder()
                        .token(UUID.randomUUID().toString())
                        .clientUser(user)
                        .expiresAt(LocalDateTime.now().plusMinutes(validMinutes))
                        .build()
        );
        return token.getToken();
    }

    private String generateUsername(String email) {
        String prefix = email.split("@")[0].toLowerCase().replaceAll("[^a-z0-9._-]", "");
        if (prefix.length() > 40) {
            prefix = prefix.substring(0, 40);
        }
        if (prefix.isBlank()) {
            prefix = "client";
        }
        if (!clientUserRepository.existsByUsername(prefix)) {
            return prefix;
        }

        for (int i = 2; i < 1000; i++) {
            String candidate = prefix + i;
            if (!clientUserRepository.existsByUsername(candidate)) {
                return candidate;
            }
        }
        return prefix + "_" + UUID.randomUUID().toString().substring(0, 6);
    }

    private String buildVerifyLink(String frontendBaseUrl, String token) {
        return trimTrailingSlash(frontendBaseUrl) + "/client/verify?token=" + token;
    }

    private String resolveFrontendBaseUrl(String requestedBaseUrl) {
        String normalizedConfigured = trimTrailingSlash(configuredBaseUrl);
        String normalizedRequested = trimTrailingSlash(requestedBaseUrl);

        if (normalizedRequested.isBlank()) {
            return normalizedConfigured;
        }
        if (normalizedConfigured.isBlank()) {
            return normalizedRequested;
        }

        try {
            URI configured = URI.create(normalizedConfigured);
            URI requested = URI.create(normalizedRequested);

            boolean sameOrigin = Objects.equals(configured.getScheme(), requested.getScheme())
                    && Objects.equals(configured.getHost(), requested.getHost())
                    && normalizePort(configured) == normalizePort(requested);

            return sameOrigin ? normalizedConfigured : normalizedRequested;
        } catch (Exception ignored) {
            return normalizedRequested;
        }
    }

    private int normalizePort(URI uri) {
        if (uri.getPort() != -1) {
            return uri.getPort();
        }
        if ("https".equalsIgnoreCase(uri.getScheme())) {
            return 443;
        }
        if ("http".equalsIgnoreCase(uri.getScheme())) {
            return 80;
        }
        return -1;
    }

    private void sendEmail(String toEmail, String subject, String body) {
        validateMailConfiguration();

        try {
            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, false, StandardCharsets.UTF_8.name());
            helper.setTo(toEmail);

            String from = resolveFromAddress(mailFrom);
            if (from != null) {
                helper.setFrom(from);
            }

            helper.setSubject(subject);
            helper.setText(body, true);
            mailSender.send(message);
        } catch (Exception e) {
            log.error("Mail send failed: to={}, host={}, user={}", toEmail, mailHost, mailFrom, e);
            throw new RuntimeException(MSG_MAIL_SEND_FAILED);
        }
    }

    private void validateMailConfiguration() {
        if (mailHost == null || mailHost.isBlank()
                || mailFrom == null || mailFrom.isBlank()
                || mailPassword == null || mailPassword.isBlank()) {
            log.error(
                    "Mail configuration missing: hostPresent={}, userPresent={}, passwordPresent={}",
                    mailHost != null && !mailHost.isBlank(),
                    mailFrom != null && !mailFrom.isBlank(),
                    mailPassword != null && !mailPassword.isBlank()
            );
            throw new RuntimeException(MSG_MAIL_NOT_CONFIGURED);
        }
    }

    // ── Email body builders ──────────────────────────────────────────────

    private String buildLoginBody(String companyName, String link, int minutes) {
        return htmlMail(
                "로그인 링크",
                "안녕하세요, " + fallback(companyName) + " 담당자님.",
                "HD Sign 거래처 포털 로그인 링크입니다.<br>"
                        + "아래 버튼을 클릭하면 로그인됩니다.",
                link,
                "로그인하기",
                "이 링크는 " + minutes + "분간 유효하며, 한 번만 사용할 수 있습니다.<br>"
                        + "본인이 요청하지 않으셨다면 이 메일을 무시해 주세요."
        );
    }

    private String buildApprovalBody(String companyName, String link) {
        return htmlMail(
                "가입 승인 안내",
                "안녕하세요, " + fallback(companyName) + " 담당자님.",
                "HD Sign 거래처 포털 가입이 승인되었습니다. 환영합니다.<br>"
                        + "아래 버튼을 클릭하면 포털에 로그인됩니다.",
                link,
                "포털 시작하기",
                "이 링크는 24시간 유효합니다.<br>"
                        + "이후에는 포털 로그인 화면에서 이메일을 입력하시면 새 링크를 받을 수 있습니다."
        );
    }

    private String buildRegistrationReceivedBody(String companyName, String contactName, String phone, boolean firstRequest) {
        String headline = firstRequest
                ? "HD Sign 거래처 포털 가입 신청이 접수되었습니다."
                : "HD Sign 거래처 포털 가입 신청이 이미 접수된 상태입니다.";
        String rows = infoRow("상호명", fallback(companyName))
                + infoRow("담당자", fallback(contactName))
                + infoRow("연락처", fallback(phone));
        return htmlMailNoButton(
                "가입 신청 접수",
                "안녕하세요, " + fallback(contactName) + "님.",
                headline + "<br><br>" + infoTable(rows)
                        + "관리자 확인 후 로그인 링크를 보내드리겠습니다.<br>"
                        + "승인 이후에는 이메일만으로 로그인할 수 있습니다."
        );
    }

    private void sendRegistrationNotificationToAdmin(String email, String companyName, String contactName, String phone, String frontendBaseUrl) {
        if (adminReceiver == null || adminReceiver.isBlank()) {
            return;
        }

        String adminPath = trimTrailingSlash(frontendBaseUrl) + "/admin/clients";
        String rows = infoRow("상호명", fallback(companyName))
                + infoRow("담당자", fallback(contactName))
                + infoRow("연락처", fallback(phone))
                + infoRow("이메일", email);
        String body = htmlMail(
                "신규 거래처 가입 신청",
                "HD Sign 관리자님",
                "새 거래처 가입 신청이 접수되었습니다.<br><br>"
                        + infoTable(rows)
                        + "관리자 페이지에서 승인 또는 거절을 진행해주세요.",
                adminPath,
                "관리자 페이지로 이동",
                null
        );
        sendEmail(adminReceiver, "[HD Sign] 새 거래처 가입 신청", body);
    }

    // ── HTML template helpers ────────────────────────────────────────────

    private String htmlMail(String title, String greeting, String bodyHtml, String btnUrl, String btnText, String footerHtml) {
        String btn = (btnUrl != null && btnText != null)
                ? "<div style='text-align:center;margin:32px 0'>"
                + "<a href='" + btnUrl + "' "
                + "style='background:#1a1a1a;color:#fff;text-decoration:none;"
                + "padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block'>"
                + btnText + "</a></div>"
                : "";
        String footer = (footerHtml != null && !footerHtml.isBlank())
                ? "<p style='font-size:13px;color:#999;margin-top:24px'>" + footerHtml + "</p>"
                : "";
        return "<!DOCTYPE html><html><body style='margin:0;padding:0;background:#f5f5f5;"
                + "font-family:\"Apple SD Gothic Neo\",\"Malgun Gothic\",sans-serif'>"
                + "<div style='max-width:520px;margin:40px auto;background:#fff;"
                + "border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)'>"
                + "<div style='background:#1a1a1a;padding:24px 36px'>"
                + "<span style='color:#fff;font-size:20px;font-weight:700;letter-spacing:1px'>HD Sign</span></div>"
                + "<div style='padding:36px'>"
                + "<h2 style='margin:0 0 8px;font-size:18px;color:#1a1a1a'>" + title + "</h2>"
                + "<p style='margin:0 0 16px;color:#555'>" + greeting + "</p>"
                + "<p style='color:#333;line-height:1.7;margin:0'>" + bodyHtml + "</p>"
                + btn
                + footer
                + "<hr style='border:none;border-top:1px solid #eee;margin:28px 0'>"
                + "<p style='font-size:12px;color:#bbb;margin:0'>HD Sign &nbsp;|&nbsp; hdno88@daum.net<br>"
                + "이 메일은 시스템에서 자동 발송되었습니다.</p>"
                + "</div></div></body></html>";
    }

    private String htmlMailNoButton(String title, String greeting, String bodyHtml) {
        return htmlMail(title, greeting, bodyHtml, null, null, null);
    }

    private String infoTable(String rows) {
        return "<table style='width:100%;border-top:1px solid #eee;border-bottom:1px solid #eee;"
                + "margin:16px 0;border-collapse:collapse'>" + rows + "</table>";
    }

    private String infoRow(String label, String value) {
        return "<tr>"
                + "<td style='padding:7px 0;color:#888;width:80px;font-size:14px'>" + label + "</td>"
                + "<td style='padding:7px 0;font-weight:600;font-size:14px'>" + value + "</td>"
                + "</tr>";
    }

    private String resolveFromAddress(String from) {
        if (from == null || from.isBlank()) {
            return null;
        }
        if (from.contains("@")) {
            return from;
        }

        String host = mailHost == null ? "" : mailHost.toLowerCase();
        if (host.contains("naver.com")) {
            return from + "@naver.com";
        }
        if (host.contains("daum.net")) {
            return from + "@daum.net";
        }
        return null;
    }

    private String normalizeEmail(String email) {
        return email == null ? "" : email.trim().toLowerCase();
    }

    private String normalizeText(String value) {
        return value == null ? "" : value.trim();
    }

    private String fallback(String value) {
        return value == null || value.isBlank() ? "-" : value;
    }

    private String trimTrailingSlash(String value) {
        if (value == null) {
            return "";
        }
        return value.trim().replaceAll("/+$", "");
    }
}
