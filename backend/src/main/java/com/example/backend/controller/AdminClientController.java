package com.example.backend.controller;

import com.example.backend.dto.ClientUserDto;
import com.example.backend.entity.ClientUser;
import com.example.backend.repository.ClientUserRepository;
import com.example.backend.repository.OrderRepository;
import com.example.backend.entity.Order;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/admin/clients")
@RequiredArgsConstructor
public class AdminClientController {

    private final ClientUserRepository clientUserRepository;
    private final OrderRepository orderRepository;
    private final PasswordEncoder passwordEncoder;

    @GetMapping
    public ResponseEntity<List<ClientUserDto.Response>> listClients() {
        return ResponseEntity.ok(
                clientUserRepository.findAllByOrderByCreatedAtDesc()
                        .stream()
                        .map(this::toResponse)
                        .toList()
        );
    }

    @PostMapping
    public ResponseEntity<ClientUserDto.Response> createClient(@RequestBody ClientUserDto.CreateRequest req) {
        if (req.getCompanyName() == null || req.getCompanyName().isBlank())
            throw new IllegalArgumentException("업체명을 입력해주세요.");

        boolean pending = Boolean.TRUE.equals(req.getPendingSignup());

        ClientUser.ClientUserBuilder builder = ClientUser.builder()
                .companyName(req.getCompanyName().trim())
                .networkFolderName(req.getNetworkFolderName() != null ? req.getNetworkFolderName().trim() : "")
                .contactName(req.getContactName() != null ? req.getContactName().trim() : "")
                .phone(req.getPhone() != null ? req.getPhone().trim() : "")
                .email(req.getEmail() != null && !req.getEmail().isBlank() ? req.getEmail().trim().toLowerCase() : null)
                .aliases(normalizeAliases(req.getAliases()));

        if (pending) {
            // 가입대기 — username/password 비워둠. 거래처가 가입 신청 시 채워지고,
            // 관리자가 [승인] 누를 때 비번이 자동생성된다.
            builder.username(null)
                   .password("")
                   .isActive(false)
                   .status("PENDING_SIGNUP");
        } else {
            if (req.getUsername() == null || req.getUsername().isBlank())
                throw new IllegalArgumentException("아이디를 입력해주세요.");
            if (req.getPassword() == null || req.getPassword().length() < 4)
                throw new IllegalArgumentException("비밀번호는 4자 이상이어야 합니다.");
            if (clientUserRepository.existsByUsername(req.getUsername().trim()))
                throw new IllegalArgumentException("이미 사용 중인 아이디입니다.");
            builder.username(req.getUsername().trim())
                   .password(passwordEncoder.encode(req.getPassword()))
                   .passwordPlaintext(req.getPassword())  // 분실 시 관리자 조회용
                   .isActive(true)
                   .status("ACTIVE");
        }

        ClientUser user = clientUserRepository.save(builder.build());
        return ResponseEntity.ok(toResponse(user));
    }

    /** 비번 자동생성 — 헷갈리는 글자(0/o, 1/l/i) 제외, 8자. */
    private static final char[] PW_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789".toCharArray();
    private static final java.security.SecureRandom RNG = new java.security.SecureRandom();

    private static String generatePassword() {
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) sb.append(PW_ALPHABET[RNG.nextInt(PW_ALPHABET.length)]);
        return sb.toString();
    }

    /** 가입신청 승인 — username/phone/email 은 신청 시 이미 채워진 상태.
     *  여기서 비번 자동생성 + BCrypt 해시 + 평문 보관 + ACTIVE 전환.
     *  응답에 평문 비번 포함 — 관리자가 화면에서 한 번 보고 거래처에 전달. */
    @PostMapping("/{id}/approve")
    public ResponseEntity<Map<String, Object>> approveSignup(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        if (!"PENDING_APPROVAL".equals(user.getStatus()))
            throw new IllegalArgumentException("승인 대기 상태가 아닙니다.");
        if (user.getUsername() == null || user.getUsername().isBlank())
            throw new IllegalArgumentException("신청 정보가 비어있습니다.");

        String plaintext = generatePassword();
        user.setPassword(passwordEncoder.encode(plaintext));
        user.setPasswordPlaintext(plaintext);
        user.setStatus("ACTIVE");
        user.setIsActive(true);
        clientUserRepository.save(user);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("companyName", user.getCompanyName());
        body.put("username", user.getUsername());
        body.put("password", plaintext);
        body.put("message", "가입 승인 — 거래처에 아이디/비번을 전달해주세요.");
        return ResponseEntity.ok(body);
    }

    /** 가입신청 거부 — 신청 정보(username/phone/email) 비우고 PENDING_SIGNUP 으로 복귀.
     *  거래처는 다시 신청할 수 있고, 관리자는 거래처 행을 삭제할 수도 있다. */
    @PostMapping("/{id}/reject")
    public ResponseEntity<Map<String, String>> rejectSignup(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        if (!"PENDING_APPROVAL".equals(user.getStatus()))
            throw new IllegalArgumentException("승인 대기 상태가 아닙니다.");
        user.setUsername(null);
        user.setPhone(null);
        // 거래처가 가입 신청 시 입력한 이메일은 비움 — 관리자가 미리 박은 이메일이 아니라 신청자 입력.
        user.setEmail(null);
        user.setSignupRequestedAt(null);
        user.setStatus("PENDING_SIGNUP");
        clientUserRepository.save(user);
        return ResponseEntity.ok(Map.of("message", "가입 신청이 거부되었습니다."));
    }

    /** 비번 재발급 — 자동생성 비번을 새로 발급해 평문/해시 모두 갱신. 응답에 평문 포함.
     *  거래처가 비번 분실 문의 시 관리자가 사용. */
    @PostMapping("/{id}/regenerate-password")
    public ResponseEntity<Map<String, Object>> regeneratePassword(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        if (!"ACTIVE".equals(user.getStatus()))
            throw new IllegalArgumentException("활성 계정에서만 재발급 가능합니다.");
        String plaintext = generatePassword();
        user.setPassword(passwordEncoder.encode(plaintext));
        user.setPasswordPlaintext(plaintext);
        clientUserRepository.save(user);
        return ResponseEntity.ok(Map.of(
                "username", user.getUsername(),
                "password", plaintext,
                "message", "비번이 재발급되었습니다. 거래처에 전달해주세요."
        ));
    }

    /** 평문 비번 조회 — 분실 문의 시 관리자가 다시 알려주기 위함.
     *  평문이 NULL(이전 등록 거래처)이면 재발급 안내. */
    @GetMapping("/{id}/password")
    public ResponseEntity<Map<String, Object>> getPassword(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("username", user.getUsername());
        body.put("password", user.getPasswordPlaintext());
        body.put("hasPlaintext", user.getPasswordPlaintext() != null && !user.getPasswordPlaintext().isBlank());
        return ResponseEntity.ok(body);
    }

    @PutMapping("/{id}")
    public ResponseEntity<ClientUserDto.Response> updateClient(
            @PathVariable Long id,
            @RequestBody ClientUserDto.UpdateRequest req
    ) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));

        if (req.getCompanyName() != null && !req.getCompanyName().isBlank())
            user.setCompanyName(req.getCompanyName().trim());
        if (req.getNetworkFolderName() != null)
            user.setNetworkFolderName(req.getNetworkFolderName().trim());
        if (req.getContactName() != null)
            user.setContactName(req.getContactName().trim());
        if (req.getPhone() != null)
            user.setPhone(req.getPhone().trim());
        if (req.getIsActive() != null)
            user.setIsActive(req.getIsActive());
        if (req.getEmail() != null && !req.getEmail().isBlank()) {
            String normalizedEmail = req.getEmail().trim().toLowerCase();
            clientUserRepository.findByEmail(normalizedEmail).ifPresent(existing -> {
                if (!existing.getId().equals(id))
                    throw new IllegalArgumentException("이미 등록된 이메일입니다.");
            });
            user.setEmail(normalizedEmail);
        }
        if (req.getAliases() != null) {
            user.setAliases(normalizeAliases(req.getAliases()));
        }

        return ResponseEntity.ok(toResponse(clientUserRepository.save(user)));
    }

    @PostMapping("/{id}/reset-password")
    public ResponseEntity<Map<String, String>> resetPassword(
            @PathVariable Long id,
            @RequestBody ClientUserDto.ResetPasswordRequest req
    ) {
        if (req.getNewPassword() == null || req.getNewPassword().length() < 4)
            throw new IllegalArgumentException("비밀번호는 4자 이상이어야 합니다.");

        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));

        user.setPassword(passwordEncoder.encode(req.getNewPassword()));
        clientUserRepository.save(user);
        return ResponseEntity.ok(Map.of("message", "비밀번호가 변경되었습니다."));
    }

    /** 워처 캐시 폴더 ∖ (이미 등록된 networkFolderName ∪ companyName).
     *  거래처관리에서 일괄 등록 화면을 띄울 때 후보 목록으로 사용. */
    @GetMapping("/unregistered-folders")
    public ResponseEntity<Map<String, Object>> unregisteredFolders() {
        List<String> all = NetworkFolderController.currentFolders();
        Set<String> taken = new HashSet<>();
        for (ClientUser c : clientUserRepository.findAll()) {
            String folder = c.getNetworkFolderName();
            if (folder != null && !folder.isBlank()) taken.add(normalizeKey(folder));
            String company = c.getCompanyName();
            if (company != null && !company.isBlank()) taken.add(normalizeKey(company));
        }
        List<String> remaining = new ArrayList<>();
        for (String name : all) {
            if (!taken.contains(normalizeKey(name))) remaining.add(name);
        }
        Instant syncedAt = NetworkFolderController.currentSyncedAt();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("folders", remaining);
        body.put("totalFolders", all.size());
        body.put("syncedAt", syncedAt != null ? syncedAt.toString() : null);
        return ResponseEntity.ok(body);
    }

    /** 워처가 푸시한 네트워크 거래처 폴더와 등록된 거래처를 비교해 "바뀐 것"을 정리해서 돌려준다.
     *  관리자 페이지 진입 시 안내 모달을 띄우는 용도.
     *   - newFolders: 폴더는 있는데 매칭되는 거래처가 없음 → 신규 등록 대상
     *   - missingClients: 거래처에 networkFolderName 이 있는데 그 폴더가 더 이상 없음 → 폴더명 수정/삭제 대상
     *   - renameSuggestions: missingClient 의 옛 폴더명과 비슷한 newFolder 가 있으면 "이름변경 아닌가요?" 후보
     *  hasData: 워처가 한 번이라도 푸시했는지 — false 면 모달을 띄우면 안 된다(서버 재시작 직후 등). */
    @GetMapping("/folder-diff")
    public ResponseEntity<Map<String, Object>> folderDiff() {
        List<String> folders = NetworkFolderController.currentFolders();
        Instant syncedAt = NetworkFolderController.currentSyncedAt();
        List<ClientUser> clients = clientUserRepository.findAll();

        Set<String> folderKeys = new HashSet<>();
        for (String f : folders) folderKeys.add(normalizeKey(f));

        Set<String> takenKeys = new HashSet<>();
        for (ClientUser c : clients) {
            if (c.getNetworkFolderName() != null && !c.getNetworkFolderName().isBlank())
                takenKeys.add(normalizeKey(c.getNetworkFolderName()));
            if (c.getCompanyName() != null && !c.getCompanyName().isBlank())
                takenKeys.add(normalizeKey(c.getCompanyName()));
        }

        List<String> newFolders = new ArrayList<>();
        for (String f : folders) {
            if (!takenKeys.contains(normalizeKey(f))) newFolders.add(f);
        }

        List<Map<String, Object>> missingClients = new ArrayList<>();
        for (ClientUser c : clients) {
            String nf = c.getNetworkFolderName();
            if (nf == null || nf.isBlank()) continue;
            if (folderKeys.contains(normalizeKey(nf))) continue;
            if (c.getCompanyName() != null && folderKeys.contains(normalizeKey(c.getCompanyName()))) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("companyName", c.getCompanyName());
            m.put("networkFolderName", nf);
            m.put("orderCount", orderRepository.countByClient(c));
            missingClients.add(m);
        }

        List<Map<String, Object>> renameSuggestions = new ArrayList<>();
        for (Map<String, Object> mc : missingClients) {
            String oldF = (String) mc.get("networkFolderName");
            String oldK = normalizeKey(oldF);
            if (oldK.isEmpty()) continue;
            for (String nf : newFolders) {
                String nk = normalizeKey(nf);
                if (nk.isEmpty() || nk.equals(oldK)) continue;
                if (oldK.contains(nk) || nk.contains(oldK)) {
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("clientId", mc.get("id"));
                    r.put("companyName", mc.get("companyName"));
                    r.put("oldFolder", oldF);
                    r.put("newFolder", nf);
                    renameSuggestions.add(r);
                }
            }
        }

        boolean hasData = syncedAt != null && !folders.isEmpty();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("hasData", hasData);
        body.put("syncedAt", syncedAt != null ? syncedAt.toString() : null);
        body.put("totalFolders", folders.size());
        body.put("newFolders", newFolders);
        body.put("missingClients", missingClients);
        body.put("renameSuggestions", renameSuggestions);
        body.put("hasChanges", hasData && (!newFolders.isEmpty() || !missingClients.isEmpty()));
        return ResponseEntity.ok(body);
    }

    /** 행 배열을 받아 각각 거래처 계정으로 등록. 행 단위 결과 리포트 반환 —
     *  실패한 행이 있어도 다른 행은 영향 없이 처리한다(트랜잭션 묶지 않음). */
    @PostMapping("/bulk")
    public ResponseEntity<Map<String, Object>> bulkCreate(@RequestBody ClientUserDto.BulkCreateRequest req) {
        List<Map<String, Object>> results = new ArrayList<>();
        int success = 0;
        int failed = 0;
        if (req != null && req.getRows() != null) {
            for (ClientUserDto.BulkCreateRow row : req.getRows()) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("networkFolderName", row.getNetworkFolderName());
                try {
                    if (row.getCompanyName() == null || row.getCompanyName().isBlank())
                        throw new IllegalArgumentException("업체명을 입력해주세요.");
                    boolean pending = Boolean.TRUE.equals(row.getPendingSignup());

                    ClientUser.ClientUserBuilder b = ClientUser.builder()
                            .companyName(row.getCompanyName().trim())
                            .networkFolderName(row.getNetworkFolderName() != null ? row.getNetworkFolderName().trim() : "")
                            .contactName(row.getContactName() != null ? row.getContactName().trim() : "")
                            .phone(row.getPhone() != null ? row.getPhone().trim() : "")
                            .email(row.getEmail() != null && !row.getEmail().isBlank() ? row.getEmail().trim().toLowerCase() : null)
                            .aliases(normalizeAliases(row.getAliases()));

                    if (pending) {
                        b.username(null).password("").isActive(false).status("PENDING_SIGNUP");
                    } else {
                        if (row.getUsername() == null || row.getUsername().isBlank())
                            throw new IllegalArgumentException("아이디를 입력해주세요.");
                        if (row.getPassword() == null || row.getPassword().length() < 4)
                            throw new IllegalArgumentException("비밀번호는 4자 이상이어야 합니다.");
                        String username = row.getUsername().trim();
                        if (clientUserRepository.existsByUsername(username))
                            throw new IllegalArgumentException("이미 사용 중인 아이디");
                        b.username(username)
                         .password(passwordEncoder.encode(row.getPassword()))
                         .passwordPlaintext(row.getPassword())
                         .isActive(true).status("ACTIVE");
                    }

                    clientUserRepository.save(b.build());
                    r.put("ok", true);
                    success++;
                } catch (Exception e) {
                    r.put("ok", false);
                    r.put("error", e.getMessage());
                    failed++;
                }
                results.add(r);
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("success", success);
        body.put("failed", failed);
        body.put("results", results);
        return ResponseEntity.ok(body);
    }

    /** 별칭 입력 정규화 — 콤마/세미콜론/줄바꿈 구분, 토큰 trim, 빈토큰 제거, 중복 제거.
     *  결과는 ", " 로 다시 합쳐 보관 (사람이 읽기 쉬움). */
    private static String normalizeAliases(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String[] tokens = raw.split("[,;\\n]+");
        java.util.LinkedHashSet<String> uniq = new java.util.LinkedHashSet<>();
        for (String t : tokens) {
            String s = t.trim();
            if (!s.isEmpty()) uniq.add(s);
        }
        if (uniq.isEmpty()) return null;
        return String.join(", ", uniq);
    }

    /** 폴더명 ↔ 거래처명 매칭용 정규화: NFC + 공백 제거 + 소문자.
     *  워처의 _normalize_company_key 와 동일 규칙. */
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

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> deleteClient(@PathVariable Long id) {
        ClientUser user = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("계정을 찾을 수 없습니다."));
        long orderCount = orderRepository.countByClient(user);
        if (orderCount > 0) {
            // 주문(작업지시서) 이력이 있으면 orders.client_id FK 제약으로 hard delete 불가 —
            // soft-delete 된 주문도 FK 가 살아있다. 삭제 대신 비활성화로 대체한다.
            user.setIsActive(false);
            user.setStatus("DISABLED");
            clientUserRepository.save(user);
            return ResponseEntity.ok(Map.of(
                    "deactivated", true,
                    "orderCount", orderCount,
                    "message", "주문 이력 " + orderCount + "건이 있어 삭제 대신 비활성화 처리했습니다."
            ));
        }
        clientUserRepository.delete(user);
        return ResponseEntity.ok(Map.of(
                "deactivated", false,
                "message", "거래처 계정이 삭제되었습니다."
        ));
    }

    /** 거래처 통합 — {id} 거래처의 모든 지시서(주문)를 {targetId} 거래처로 옮긴 뒤 {id} 계정을 삭제한다.
     *  업체 폴더명 변경 등으로 한 거래처가 둘로 갈라졌을 때 합치는 용도.
     *  옮긴 지시서의 거래처명 표시는 join 이라 자동으로 대상 거래처명으로 바뀐다. */
    @PostMapping("/{id}/merge-into/{targetId}")
    @Transactional
    public ResponseEntity<Map<String, Object>> mergeInto(@PathVariable Long id, @PathVariable Long targetId) {
        if (id.equals(targetId))
            throw new IllegalArgumentException("같은 거래처로는 통합할 수 없습니다.");
        ClientUser from = clientUserRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("옮길 거래처를 찾을 수 없습니다."));
        ClientUser to = clientUserRepository.findById(targetId)
                .orElseThrow(() -> new RuntimeException("대상 거래처를 찾을 수 없습니다."));
        List<Order> orders = orderRepository.findByClient(from);
        for (Order o : orders) o.setClient(to);
        orderRepository.saveAll(orders);
        clientUserRepository.delete(from);
        return ResponseEntity.ok(Map.of(
                "movedOrders", orders.size(),
                "fromName", from.getCompanyName(),
                "toName", to.getCompanyName(),
                "message", "'" + from.getCompanyName() + "' 의 지시서 " + orders.size()
                        + "건을 '" + to.getCompanyName() + "' 로 옮기고 '" + from.getCompanyName() + "' 계정을 삭제했습니다."
        ));
    }

    private ClientUserDto.Response toResponse(ClientUser user) {
        return new ClientUserDto.Response(
                user.getId(),
                user.getUsername(),
                user.getCompanyName(),
                user.getNetworkFolderName(),
                user.getContactName(),
                user.getPhone(),
                user.getEmail(),
                user.getAliases(),
                user.getIsActive(),
                user.getStatus(),
                user.getSignupRequestedAt() != null ? user.getSignupRequestedAt().toString() : null,
                user.getCreatedAt() != null ? user.getCreatedAt().toString() : null
        );
    }
}
