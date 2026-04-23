package com.example.backend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class MailService {

    private static final long ATTACH_LIMIT = 10L * 1024 * 1024;
    private static final long ATTACH_TOTAL_LIMIT = ATTACH_LIMIT * 2;

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    @Value("${order.mail.to}")
    private String mailTo;

    @Value("${mail.from}")
    private String mailFrom;

    @Value("${resend.api-key:}")
    private String resendApiKey;

    @Value("${resend.api-base-url:https://api.resend.com}")
    private String resendApiBaseUrl;

    @Async
    public void sendOrderNotification(OrderNotification order, List<MultipartFile> files) {
        if (resendApiKey == null || resendApiKey.isBlank()) {
            log.error("Resend API key is missing. Skipping order notification mail: {}", order.orderNumber());
            return;
        }

        try {
            FileBundle fileBundle = buildFileBundle(files, order.storedFiles());
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("from", mailFrom);
            payload.put("to", List.of(mailTo));
            payload.put("subject", buildSubject(order));
            payload.put("html", buildHtml(order, fileBundle.htmlSection()));
            payload.put("tags", List.of(
                    tag("email_type", "order_notification"),
                    tag("order_number", sanitizeTagValue(order.orderNumber()))
            ));
            if (!fileBundle.attachments().isEmpty()) {
                payload.put("attachments", fileBundle.attachments());
            }

            String requestBody = objectMapper.writeValueAsString(payload);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(resendApiBaseUrl + "/emails"))
                    .timeout(Duration.ofSeconds(20))
                    .header("Authorization", "Bearer " + resendApiKey)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                    .build();

            log.info(
                    "Preparing order notification mail via Resend: orderNumber={}, to={}, from={}, fileCount={}",
                    order.orderNumber(),
                    mailTo,
                    mailFrom,
                    files == null ? 0 : files.size()
            );

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException(
                        "Resend responded with status " + response.statusCode() + ": " + response.body()
                );
            }

            JsonNode body = objectMapper.readTree(response.body());
            log.info(
                    "Order notification mail sent successfully: orderNumber={}, emailId={}",
                    order.orderNumber(),
                    body.path("id").asText("-")
            );
        } catch (Exception e) {
            log.error("Order notification mail failed: {}", order.orderNumber(), e);
        }
    }

    private Map<String, String> tag(String name, String value) {
        return Map.of("name", name, "value", value);
    }

    private String sanitizeTagValue(String value) {
        if (value == null || value.isBlank()) {
            return "unknown";
        }
        return value.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private String buildSubject(OrderNotification order) {
        return "[HD Sign] 작업 요청 접수 - " + blankOr(order.title(), "제목 없음")
                + " (" + order.orderNumber() + ")";
    }

    private FileBundle buildFileBundle(List<MultipartFile> files, List<StoredFileLink> storedFiles) throws Exception {
        if (files == null || files.isEmpty()) {
            return new FileBundle("", List.of());
        }

        Map<String, String> linkByName = new LinkedHashMap<>();
        for (StoredFileLink storedFile : storedFiles) {
            linkByName.putIfAbsent(storedFile.originalName(), storedFile.fileUrl());
        }

        List<Map<String, String>> attachments = new ArrayList<>();
        StringBuilder rows = new StringBuilder();
        long totalAttached = 0;

        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) {
                continue;
            }

            String name = blankOr(file.getOriginalFilename(), "unknown");
            long size = file.getSize();
            String sizeText = formatSize(size);
            boolean attach = size <= ATTACH_LIMIT && totalAttached + size <= ATTACH_TOTAL_LIMIT;

            if (attach) {
                attachments.add(Map.of(
                        "filename", name,
                        "content", Base64.getEncoder().encodeToString(file.getBytes())
                ));
                totalAttached += size;
                rows.append(fileRow(name, sizeText, "첨부", "#16a34a", null));
            } else {
                rows.append(fileRow(name, sizeText, "링크", "#d97706", linkByName.get(name)));
            }
        }

        if (rows.isEmpty()) {
            return new FileBundle("", attachments);
        }

        String htmlSection = """
                <section style="margin-top:28px">
                  <h3 style="margin:0 0 12px;font-size:15px;color:#0f172a">첨부 파일</h3>
                  <table style="width:100%%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
                    %s
                  </table>
                </section>
                """.formatted(rows);

        return new FileBundle(htmlSection, attachments);
    }

    private String fileRow(String name, String size, String tag, String tagColor, String link) {
        String button = link == null || link.isBlank()
                ? ""
                : "<a href=\"" + esc(link) + "\" "
                + "style=\"display:inline-block;margin-left:10px;padding:4px 10px;background:#2563eb;color:#fff;text-decoration:none;border-radius:999px;font-size:11px;font-weight:700\">다운로드</a>";

        return """
                <tr>
                  <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;word-break:break-all">
                    %s
                    <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:%s;color:#fff;font-size:11px;font-weight:700">%s</span>
                    %s
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;text-align:right;white-space:nowrap">%s</td>
                </tr>
                """.formatted(esc(name), tagColor, tag, button, size);
    }

    private String buildHtml(OrderNotification order, String fileSection) {
        String title = blankOr(order.title(), "제목 없음");
        String items = blankOr(order.additionalItems(), "없음");
        String note = blankOr(order.note(), "");
        String deliveryAddress = blankOr(order.deliveryAddress(), "-");
        String createdAt = order.createdAt() == null
                ? "-"
                : order.createdAt().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        String dueDate = order.dueDate() == null
                ? "-"
                : order.dueDate().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"));
        String dueTime = blankOr(order.dueTime(), "시간 미정");

        String noteSection = note.isBlank()
                ? ""
                : """
                  <section style="margin-top:28px">
                    <h3 style="margin:0 0 12px;font-size:15px;color:#0f172a">추가 요청사항</h3>
                    <div style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;color:#334155;font-size:13px;line-height:1.8">%s</div>
                  </section>
                  """.formatted(esc(note).replace("\n", "<br>"));

        return """
                <!DOCTYPE html>
                <html lang="ko">
                <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="margin:0;padding:24px;background:#eef2f7;font-family:'Malgun Gothic',Arial,sans-serif;color:#0f172a">
                  <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ec;border-radius:16px;overflow:hidden">
                    <div style="padding:28px 32px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff">
                      <div style="font-size:13px;letter-spacing:.08em;opacity:.8">HD SIGN</div>
                      <h1 style="margin:10px 0 8px;font-size:24px;line-height:1.3">작업 요청이 접수되었습니다</h1>
                      <div style="font-size:14px;opacity:.9">%s</div>
                    </div>

                    <div style="padding:28px 32px">
                      <section>
                        <table style="width:100%%;border-collapse:collapse">
                          %s
                          %s
                          %s
                          %s
                          %s
                          %s
                          %s
                          %s
                          %s
                        </table>
                      </section>

                      %s
                      %s
                    </div>
                  </div>

                  <div style="max-width:760px;margin:14px auto 0;color:#94a3b8;font-size:11px;text-align:center">
                    이 메일은 시스템에서 자동 발송되었습니다.
                  </div>
                </body>
                </html>
                """.formatted(
                order.orderNumber(),
                infoRow("주문번호", order.orderNumber()),
                infoRow("접수시각", createdAt),
                infoRow("거래처", order.companyName()),
                infoRow("담당자", order.contactName()),
                infoRow("연락처", order.phone()),
                infoRow("작업 제목", title),
                infoRow("추가 물품", items),
                infoRow("납기", dueDate + " / " + dueTime),
                infoRow("배송 정보", order.deliveryMethodLabel() + " / " + deliveryAddress),
                noteSection,
                fileSection
        );
    }

    private String infoRow(String label, String value) {
        return """
                <tr>
                  <th style="width:110px;padding:12px 0;border-bottom:1px solid #e2e8f0;text-align:left;color:#64748b;font-size:12px;font-weight:700">%s</th>
                  <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;line-height:1.6">%s</td>
                </tr>
                """.formatted(esc(label), esc(blankOr(value, "-")));
    }

    private String formatSize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        }
        return String.format("%.1f MB", bytes / (1024.0 * 1024));
    }

    private String blankOr(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private String esc(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    public record OrderNotification(
            String orderNumber,
            LocalDateTime createdAt,
            String companyName,
            String contactName,
            String phone,
            String title,
            String additionalItems,
            String note,
            LocalDate dueDate,
            String dueTime,
            String deliveryMethodLabel,
            String deliveryAddress,
            List<StoredFileLink> storedFiles
    ) {}

    public record StoredFileLink(String originalName, String fileUrl) {}

    private record FileBundle(String htmlSection, List<Map<String, String>> attachments) {}
}
