package com.example.backend.service;

import com.example.backend.entity.Order;
import com.example.backend.entity.OrderFile;
import jakarta.mail.internet.MimeMessage;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class MailService {

    private static final long ATTACH_LIMIT = 10L * 1024 * 1024;

    private final JavaMailSender mailSender;

    @Value("${order.mail.to}")
    private String mailTo;

    @Value("${spring.mail.username}")
    private String mailFrom;

    @Value("${spring.mail.host}")
    private String mailHost;

    @Async
    public void sendOrderNotification(Order order, List<MultipartFile> files) {
        try {
            log.info(
                    "Preparing order notification mail: orderNumber={}, to={}, from={}, host={}, fileCount={}",
                    order.getOrderNumber(),
                    mailTo,
                    mailFrom,
                    mailHost,
                    files == null ? 0 : files.size()
            );

            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
            helper.setFrom(mailFrom);
            helper.setTo(mailTo);
            helper.setSubject(buildSubject(order));

            Map<String, String> r2Links = order.getFiles().stream()
                    .collect(Collectors.toMap(OrderFile::getOriginalName, OrderFile::getFileUrl, (a, b) -> a));

            String fileSection = buildFileSection(files, r2Links, helper);
            helper.setText(buildHtml(order, fileSection), true);
            mailSender.send(message);

            log.info("Order notification mail sent successfully: {}", order.getOrderNumber());
        } catch (Exception e) {
            log.error("Order notification mail failed: {}", order.getOrderNumber(), e);
        }
    }

    private String buildSubject(Order order) {
        return "[HD Sign] 새 작업 요청 - " + blankOr(order.getTitle(), "제목 없음")
                + " (" + order.getOrderNumber() + ")";
    }

    private String buildFileSection(
            List<MultipartFile> files,
            Map<String, String> r2Links,
            MimeMessageHelper helper
    ) throws Exception {
        if (files == null || files.isEmpty()) {
            return "";
        }

        StringBuilder rows = new StringBuilder();
        long totalAttached = 0;

        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) {
                continue;
            }

            String name = file.getOriginalFilename() != null ? file.getOriginalFilename() : "unknown";
            long size = file.getSize();
            String sizeText = formatSize(size);
            boolean attach = size <= ATTACH_LIMIT && totalAttached + size <= ATTACH_LIMIT * 2;

            if (attach) {
                helper.addAttachment(name, new ByteArrayResource(file.getBytes()));
                totalAttached += size;
                rows.append(fileRow(name, sizeText, "첨부", "#16a34a", null));
            } else {
                rows.append(fileRow(name, sizeText, "링크", "#d97706", r2Links.get(name)));
            }
        }

        if (rows.isEmpty()) {
            return "";
        }

        return """
                <section style="margin-top:28px">
                  <h3 style="margin:0 0 12px;font-size:15px;color:#0f172a">첨부 파일</h3>
                  <table style="width:100%%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
                    %s
                  </table>
                </section>
                """.formatted(rows);
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

    private String buildHtml(Order order, String fileSection) {
        String company = order.getClient() != null ? blankOr(order.getClient().getCompanyName(), "-") : "-";
        String contact = order.getClient() != null ? blankOr(order.getClient().getContactName(), "-") : "-";
        String phone = order.getClient() != null ? blankOr(order.getClient().getPhone(), "-") : "-";
        String title = blankOr(order.getTitle(), "제목 없음");
        String items = blankOr(order.getAdditionalItems(), "없음");
        String note = blankOr(order.getNote(), "");
        String deliveryAddress = blankOr(order.getDeliveryAddress(), "-");
        String createdAt = order.getCreatedAt() == null
                ? "-"
                : order.getCreatedAt().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        String dueDate = order.getDueDate() == null
                ? "-"
                : order.getDueDate().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"));
        String dueTime = blankOr(order.getDueTime(), "시간 미정");

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
                      <h1 style="margin:10px 0 8px;font-size:24px;line-height:1.3">새 작업 요청이 접수되었습니다</h1>
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
                order.getOrderNumber(),
                infoRow("주문번호", order.getOrderNumber()),
                infoRow("접수시각", createdAt),
                infoRow("거래처", company),
                infoRow("담당자", contact),
                infoRow("연락처", phone),
                infoRow("작업 제목", title),
                infoRow("추가 물품", items),
                infoRow("납기", dueDate + " / " + dueTime),
                infoRow("배송 정보", order.getDeliveryMethod().name() + " / " + deliveryAddress),
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
}
