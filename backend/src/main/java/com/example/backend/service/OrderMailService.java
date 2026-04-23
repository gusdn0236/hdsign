package com.example.backend.service;

import com.example.backend.entity.ClientUser;
import com.example.backend.entity.Order;
import jakarta.mail.internet.MimeMessage;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.nio.charset.StandardCharsets;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class OrderMailService {

    private final JavaMailSender mailSender;
    private final S3Client s3Client;

    @Value("${order.mail.to:}")
    private String orderReceiver;

    @Value("${spring.mail.username:}")
    private String mailFrom;

    @Value("${spring.mail.host:}")
    private String mailHost;

    @Value("${order.mail.large-link-threshold-mb:25}")
    private long largeLinkThresholdMb;

    @Value("${order.mail.large-link-expire-days:30}")
    private int largeLinkExpireDays;

    @Value("${r2.bucket}")
    private String r2Bucket;

    @Value("${r2.public-url}")
    private String r2PublicUrl;

    public void sendOrderMail(Order order, ClientUser client, List<MultipartFile> files) {
        if (orderReceiver == null || orderReceiver.isBlank()) {
            throw new IllegalArgumentException("Mail receiver is not configured. Please set ORDER_MAIL_TO.");
        }

        List<MultipartFile> normalizedFiles = new ArrayList<>();
        if (files != null) {
            for (MultipartFile file : files) {
                if (file == null || file.isEmpty()) continue;
                normalizedFiles.add(file);
            }
        }

        long thresholdBytes = largeLinkThresholdMb * 1024L * 1024L;
        List<MultipartFile> attachableFiles = new ArrayList<>();
        List<LargeFileLink> linkedFiles = new ArrayList<>();
        long attachedBytes = 0L;

        for (MultipartFile file : normalizedFiles) {
            long size = file.getSize();
            if (attachedBytes + size <= thresholdBytes) {
                attachableFiles.add(file);
                attachedBytes += size;
            } else {
                linkedFiles.add(uploadAsLargeLink(order, file));
            }
        }

        try {
            MimeMessage mimeMessage = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mimeMessage, true, StandardCharsets.UTF_8.name());

            helper.setTo(orderReceiver);
            String fromAddress = resolveFromAddress(mailFrom);
            if (fromAddress != null) {
                helper.setFrom(fromAddress);
            }

            helper.setSubject(buildSubject(order, client));
            helper.setText(buildBody(order, client, attachableFiles, linkedFiles), false);

            for (MultipartFile file : attachableFiles) {
                String filename = file.getOriginalFilename() == null ? "attachment.bin" : file.getOriginalFilename();
                helper.addAttachment(filename, new ByteArrayResource(file.getBytes()));
            }

            mailSender.send(mimeMessage);
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            String detail = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            throw new RuntimeException("Mail send failed. Please try again later. [cause: " + detail + "]");
        }
    }

    private String buildSubject(Order order, ClientUser client) {
        String title = (order.getTitle() == null || order.getTitle().isBlank()) ? "작업 요청" : order.getTitle();
        return "[HD Sign 작업 요청] " + title + " — " + nullToDash(client.getCompanyName());
    }

    private String buildBody(
            Order order,
            ClientUser client,
            List<MultipartFile> attachedFiles,
            List<LargeFileLink> linkedFiles
    ) {
        String div = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
        StringBuilder sb = new StringBuilder();

        sb.append("HD Sign 클라이언트 포털에서 새로운 작업 요청이 접수되었습니다.\n\n");

        sb.append(div);
        sb.append(" 주문 정보\n");
        sb.append(div);
        sb.append("주문번호  : ").append(order.getOrderNumber()).append("\n");
        sb.append("작업 제목 : ").append(nullToDash(order.getTitle())).append("\n");
        sb.append("거래처    : ").append(nullToDash(client.getCompanyName())).append("\n");
        sb.append("담당자    : ").append(nullToDash(client.getContactName())).append("\n");
        if (order.getCreatedAt() != null) {
            sb.append("접수일시  : ")
                    .append(order.getCreatedAt().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")))
                    .append("\n");
        }
        sb.append("\n");

        sb.append(div);
        sb.append(" 작업 상세\n");
        sb.append(div);
        String items = (order.getAdditionalItems() == null || order.getAdditionalItems().isBlank())
                ? "없음" : order.getAdditionalItems();
        sb.append("추가 물품  : ").append(items).append("\n");
        sb.append("납품 희망일 : ").append(order.getDueDate()).append("\n");
        sb.append("납품 시간대 : ").append(nullToDash(order.getDueTime())).append("\n");
        sb.append("납품 방법  : ").append(deliveryLabel(order.getDeliveryMethod())).append("\n");
        sb.append("납품지/주소 : ").append(nullToDash(order.getDeliveryAddress())).append("\n");
        sb.append("\n");

        sb.append(div);
        sb.append(" 추가 요청사항\n");
        sb.append(div);
        sb.append(nullToDash(order.getNote())).append("\n\n");

        sb.append(div);
        sb.append(" 첨부 파일\n");
        sb.append(div);
        if (attachedFiles.isEmpty()) {
            sb.append("없음\n");
        } else {
            for (MultipartFile file : attachedFiles) {
                sb.append("- ").append(file.getOriginalFilename())
                        .append(" (").append(formatSize(file.getSize())).append(")\n");
            }
        }
        sb.append("\n");

        sb.append(div);
        sb.append(" 대용량 파일 링크 (").append(largeLinkThresholdMb).append("MB 초과 자동 전환, ")
                .append(largeLinkExpireDays).append("일 보관)\n");
        sb.append(div);
        if (linkedFiles.isEmpty()) {
            sb.append("없음\n");
        } else {
            for (LargeFileLink file : linkedFiles) {
                sb.append("- ").append(file.originalName)
                        .append(" (").append(formatSize(file.size)).append(")\n")
                        .append("  ").append(file.url).append("\n");
            }
        }

        sb.append("\n이 메일은 시스템에서 자동 발송되었습니다.");
        return sb.toString();
    }

    private LargeFileLink uploadAsLargeLink(Order order, MultipartFile file) {
        try {
            String ext = getExtension(file.getOriginalFilename());
            String key = "orders/mail-large/" + order.getOrderNumber() + "/" + UUID.randomUUID() + ext;

            s3Client.putObject(
                    PutObjectRequest.builder()
                            .bucket(r2Bucket)
                            .key(key)
                            .contentType(normalizeContentType(file.getContentType()))
                            .cacheControl("private, max-age=0, no-store")
                            .build(),
                    RequestBody.fromBytes(file.getBytes())
            );

            String normalizedBase = r2PublicUrl.endsWith("/") ? r2PublicUrl : r2PublicUrl + "/";
            String url = normalizedBase + key;
            String originalName = file.getOriginalFilename() == null ? "attachment.bin" : file.getOriginalFilename();
            return new LargeFileLink(originalName, file.getSize(), url);
        } catch (Exception e) {
            throw new RuntimeException("Failed to upload large-file link: " + file.getOriginalFilename());
        }
    }

    private String getExtension(String filename) {
        if (filename == null || !filename.contains(".")) return "";
        return filename.substring(filename.lastIndexOf("."));
    }

    private String normalizeContentType(String contentType) {
        return (contentType == null || contentType.isBlank()) ? "application/octet-stream" : contentType;
    }

    private String deliveryLabel(Order.DeliveryMethod method) {
        if (method == null) return "-";
        return switch (method) {
            case CARGO -> "화물 발송";
            case QUICK -> "퀵 발송";
            case DIRECT -> "직접 배송";
            case PICKUP -> "직접 픽업";
        };
    }

    private String formatSize(long bytes) {
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
    }

    private String nullToDash(String value) {
        return (value == null || value.isBlank()) ? "-" : value;
    }

    private String resolveFromAddress(String from) {
        if (from == null || from.isBlank()) return null;
        if (from.contains("@")) return from;

        String host = mailHost == null ? "" : mailHost.toLowerCase();
        if (host.contains("naver.com")) return from + "@naver.com";
        if (host.contains("daum.net")) return from + "@daum.net";
        return null;
    }

    private static class LargeFileLink {
        private final String originalName;
        private final long size;
        private final String url;

        private LargeFileLink(String originalName, long size, String url) {
            this.originalName = originalName;
            this.size = size;
            this.url = url;
        }
    }
}