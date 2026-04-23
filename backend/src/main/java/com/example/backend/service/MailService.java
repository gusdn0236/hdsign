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

    private final JavaMailSender mailSender;

    @Value("${order.mail.to}")         private String mailTo;
    @Value("${spring.mail.username}")  private String mailFrom;

    private static final long ATTACH_LIMIT = 10L * 1024 * 1024; // 10 MB

    public void sendOrderNotification(Order order, List<MultipartFile> files) {
        try {
            MimeMessage msg = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(msg, true, "UTF-8");
            helper.setFrom(mailFrom);
            helper.setTo(mailTo);
            helper.setSubject(subject(order));

            Map<String, String> r2Links = order.getFiles().stream()
                    .collect(Collectors.toMap(OrderFile::getOriginalName, OrderFile::getFileUrl, (a, b) -> a));

            String fileHtml = buildFileRows(files, r2Links, helper);
            helper.setText(buildHtml(order, fileHtml), true);
            mailSender.send(msg);
            log.info("알림 메일 발송 완료: {}", order.getOrderNumber());
        } catch (Exception e) {
            log.error("알림 메일 발송 실패 [{}]: {}", order.getOrderNumber(), e.getMessage());
        }
    }

    // ────────────────────────────────────────────────────────────────
    private String subject(Order order) {
        String t = blankOr(order.getTitle(), "제목 없음");
        return "[HD Sign] 새 작업 요청 — " + t + " (" + order.getOrderNumber() + ")";
    }

    // ── 파일 행 HTML (소용량 첨부 / 대용량 링크) ──────────────────────
    private String buildFileRows(
            List<MultipartFile> files,
            Map<String, String> r2Links,
            MimeMessageHelper helper
    ) throws Exception {
        if (files == null || files.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        long totalAttached = 0;
        for (MultipartFile f : files) {
            if (f == null || f.isEmpty()) continue;
            String name = f.getOriginalFilename() != null ? f.getOriginalFilename() : "unknown";
            long   size = f.getSize();
            String sz   = fmtSize(size);
            boolean attach = size <= ATTACH_LIMIT && totalAttached + size <= ATTACH_LIMIT * 2;
            if (attach) {
                helper.addAttachment(name, new ByteArrayResource(f.getBytes()));
                totalAttached += size;
                sb.append(fileRow(name, sz, "첨부됨", "#22C55E", null));
            } else {
                String link = r2Links.get(name);
                sb.append(fileRow(name, sz, "대용량", "#F59E0B", link));
            }
        }
        return sb.toString();
    }

    private String fileRow(String name, String size, String tag, String tagColor, String link) {
        String badge = "<span style=\"display:inline-block;background:" + tagColor
                + ";color:#fff;font-size:10px;font-weight:700;padding:2px 7px;"
                + "border-radius:3px;margin-left:8px;vertical-align:middle\">" + tag + "</span>";
        String dl = link != null
                ? " &nbsp;<a href=\"" + link + "\" style=\"display:inline-block;color:#fff;"
                  + "background:#3B82F6;text-decoration:none;font-size:11px;font-weight:700;"
                  + "padding:3px 10px;border-radius:4px\">다운로드</a>"
                : "";
        return "<tr>"
                + "<td style=\"padding:9px 14px;border-bottom:1px solid #F1F5F9;"
                + "font-size:13px;color:#1E293B;word-break:break-all\">"
                + esc(name) + badge + dl + "</td>"
                + "<td style=\"padding:9px 14px;border-bottom:1px solid #F1F5F9;"
                + "font-size:12px;color:#94A3B8;white-space:nowrap;text-align:right\">"
                + size + "</td>"
                + "</tr>";
    }

    // ── 메인 HTML 템플릿 ──────────────────────────────────────────────
    private String buildHtml(Order order, String fileRows) {

        String delivery = switch (order.getDeliveryMethod()) {
            case CARGO  -> "🚛 화물 발송";
            case QUICK  -> "⚡ 퀵 발송";
            case DIRECT -> "🚗 직접 배송";
            case PICKUP -> "🏭 직접 픽업";
        };
        String addr = blankOr(order.getDeliveryAddress(), "");
        String addrHtml = addr.isBlank() ? ""
                : "<br/><span style=\"font-size:12px;color:#64748B\">▸ " + esc(addr) + "</span>";

        String dueDate = order.getDueDate() != null
                ? order.getDueDate().format(DateTimeFormatter.ofPattern("yyyy년 M월 d일")) : "-";
        String dueTime = blankOr(order.getDueTime(), "");
        String dueHtml = dueTime.isBlank() ? dueDate
                : dueDate + " &nbsp;<span style=\"color:#3B82F6;font-weight:600\">" + esc(dueTime) + "</span>";

        String company = order.getClient() != null ? esc(order.getClient().getCompanyName()) : "-";
        String contact = (order.getClient() != null
                && !blankOr(order.getClient().getContactName(), "").isBlank())
                ? "<br/><span style=\"font-size:12px;color:#64748B\">▸ "
                  + esc(order.getClient().getContactName()) + " 담당자</span>"
                : "";
        String items = blankOr(order.getAdditionalItems(), "없음");
        String note  = blankOr(order.getNote(), "");
        String createdAt = order.getCreatedAt() != null
                ? order.getCreatedAt().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")) : "-";

        String noteSection = note.isBlank() ? "" : """
                <tr>
                  <td colspan="2" style="padding:0">
                    <div style="margin-top:24px">
                      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0B1120;
                                padding-bottom:6px;border-bottom:2px solid #3B82F6">추가 요청사항</p>
                      <div style="background:#F8FAFC;border-left:3px solid #3B82F6;padding:12px 16px;
                                  font-size:13px;line-height:1.8;color:#334155;border-radius:0 6px 6px 0">
                        %s
                      </div>
                    </div>
                  </td>
                </tr>
                """.formatted(esc(note).replace("\n", "<br/>"));

        String fileSection = fileRows.isBlank() ? "" : """
                <tr>
                  <td colspan="2" style="padding:0">
                    <div style="margin-top:24px">
                      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0B1120;
                                padding-bottom:6px;border-bottom:2px solid #3B82F6">첨부 파일</p>
                      <table style="width:100%%;border-collapse:collapse;
                                    background:#F8FAFC;border-radius:6px;overflow:hidden">
                        %s
                      </table>
                    </div>
                  </td>
                </tr>
                """.formatted(fileRows);

        return """
                <!DOCTYPE html>
                <html lang="ko">
                <head><meta charset="UTF-8"/></head>
                <body style="margin:0;padding:24px;background:#EEF2F7;
                             font-family:'Malgun Gothic',Apple SD Gothic Neo,Arial,sans-serif">
                <table width="100%%" cellpadding="0" cellspacing="0"
                       style="max-width:620px;margin:0 auto">

                  <!-- 헤더 -->
                  <tr>
                    <td style="background:#0B1120;padding:24px 32px;border-radius:10px 10px 0 0">
                      <table width="100%%">
                        <tr>
                          <td>
                            <span style="color:#fff;font-size:20px;font-weight:900;
                                         letter-spacing:1px">HD SIGN</span><br/>
                            <span style="color:rgba(255,255,255,.40);font-size:12px">
                              새 작업 요청이 접수되었습니다
                            </span>
                          </td>
                          <td align="right">
                            <span style="background:#22C55E;color:#fff;font-size:11px;
                                         font-weight:700;padding:5px 12px;border-radius:20px">
                              ● 접수완료
                            </span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- 주문번호 바 -->
                  <tr>
                    <td style="background:#1E3A5F;padding:10px 32px">
                      <span style="color:#93C5FD;font-size:12px;font-weight:600">주문번호</span>
                      &nbsp;
                      <span style="color:#fff;font-size:14px;font-weight:800;
                                   letter-spacing:0.5px">%s</span>
                      <span style="float:right;color:rgba(255,255,255,.40);font-size:11px">%s</span>
                    </td>
                  </tr>

                  <!-- 본문 -->
                  <tr>
                    <td style="background:#fff;padding:28px 32px;border-radius:0 0 10px 10px">
                      <table width="100%%" cellpadding="0" cellspacing="0">

                        <!-- 정보 테이블 -->
                        <tr>
                          <td colspan="2">
                            <table width="100%%" cellpadding="0" cellspacing="0"
                                   style="border-collapse:collapse;border-radius:8px;
                                          overflow:hidden;border:1px solid #E8EEF4">
                              %s
                              %s
                              %s
                              %s
                              %s
                            </table>
                          </td>
                        </tr>

                        <!-- 추가 요청사항 -->
                        %s

                        <!-- 파일 섹션 -->
                        %s

                      </table>
                    </td>
                  </tr>

                  <!-- 푸터 -->
                  <tr>
                    <td style="padding:16px 0;text-align:center;
                               color:#94A3B8;font-size:11px">
                      HD Sign &nbsp;·&nbsp; 이 메일은 자동으로 발송된 알림입니다
                    </td>
                  </tr>

                </table>
                </body>
                </html>
                """.formatted(
                order.getOrderNumber(), createdAt,
                infoRow("거래처",    company + contact),
                infoRow("작업 제목", esc(blankOr(order.getTitle(), "제목 없음"))),
                infoRow("납품 희망일", dueHtml),
                infoRow("납품 방법",  delivery + addrHtml),
                infoRow("추가 물품",  esc(items)),
                noteSection,
                fileSection
        );
    }

    private String infoRow(String label, String value) {
        return "<tr>"
                + "<th style=\"background:#F8FAFC;color:#64748B;font-size:12px;font-weight:600;"
                + "padding:10px 14px;border-bottom:1px solid #E8EEF4;text-align:left;"
                + "width:100px;white-space:nowrap\">" + label + "</th>"
                + "<td style=\"color:#1E293B;font-size:13px;padding:10px 14px;"
                + "border-bottom:1px solid #E8EEF4;line-height:1.6\">" + value + "</td>"
                + "</tr>";
    }

    // ── 유틸 ────────────────────────────────────────────────────────
    private String fmtSize(long b) {
        if (b < 1024)        return b + " B";
        if (b < 1024 * 1024) return String.format("%.1f KB", b / 1024.0);
        return String.format("%.1f MB", b / (1024.0 * 1024));
    }

    private String blankOr(String s, String fallback) {
        return (s != null && !s.isBlank()) ? s : fallback;
    }

    private String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;");
    }
}
