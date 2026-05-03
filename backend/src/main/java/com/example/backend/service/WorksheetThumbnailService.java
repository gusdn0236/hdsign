package com.example.backend.service;

import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.UUID;

/**
 * 작업지시서 PDF 1페이지를 카드용 JPEG 으로 렌더해 R2 에 업로드.
 * 신규 PDF 업로드 (PublicEvidenceController) 와 기존 PDF 백필
 * (AdminOrderController.backfillWorksheetThumbnails) 양쪽에서 사용.
 */
@Slf4j
@Service
public class WorksheetThumbnailService {

    // 카드 표시 폭(보통 240–320px) 의 약 2배 해상도. JPEG 품질 0.7 이면 일반 지시서 1페이지가 50–120KB.
    private static final int THUMBNAIL_WIDTH_PX = 720;
    private static final float THUMBNAIL_JPEG_QUALITY = 0.7f;

    private final S3Client s3Client;
    private final String bucket;
    private final String publicUrl;

    public WorksheetThumbnailService(
            S3Client s3Client,
            @Value("${r2.bucket}") String bucket,
            @Value("${r2.public-url}") String publicUrl
    ) {
        this.s3Client = s3Client;
        this.bucket = bucket;
        this.publicUrl = publicUrl;
    }

    // PDF 1페이지를 카드용 JPEG 으로 렌더해 R2 에 업로드하고 public URL 을 반환.
    // 실패 시 null — 호출부는 폴백 처리.
    public String renderAndUpload(String orderNumber, byte[] pdfBytes) {
        BufferedImage rendered;
        try (PDDocument doc = Loader.loadPDF(pdfBytes)) {
            if (doc.getNumberOfPages() < 1) return null;
            PDFRenderer renderer = new PDFRenderer(doc);
            // 페이지 가로 픽셀 폭이 THUMBNAIL_WIDTH_PX 가 되도록 DPI 산정 (PDF 1pt = 1/72 inch).
            float pageWidthPt = doc.getPage(0).getMediaBox().getWidth();
            if (pageWidthPt <= 0) return null;
            float dpi = (THUMBNAIL_WIDTH_PX / pageWidthPt) * 72f;
            // 너무 작은 페이지에도 과도한 DPI 가 잡히지 않도록 상한.
            if (dpi > 200f) dpi = 200f;
            rendered = renderer.renderImageWithDPI(0, dpi, ImageType.RGB);
        } catch (Exception e) {
            log.warn("지시서 썸네일 렌더 실패 [{}]: {}", orderNumber, e.getMessage());
            return null;
        }

        // 렌더 결과가 목표 폭을 넘으면 한 번 더 리샘플 (품질 보존하며 파일 크기 절감).
        BufferedImage finalImage = rendered;
        if (rendered.getWidth() > THUMBNAIL_WIDTH_PX) {
            int targetW = THUMBNAIL_WIDTH_PX;
            int targetH = Math.round(rendered.getHeight() * (targetW / (float) rendered.getWidth()));
            BufferedImage resized = new BufferedImage(targetW, targetH, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = resized.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.drawImage(rendered, 0, 0, targetW, targetH, null);
            g.dispose();
            finalImage = resized;
        }

        byte[] jpegBytes;
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(THUMBNAIL_JPEG_QUALITY);
            try (MemoryCacheImageOutputStream ios = new MemoryCacheImageOutputStream(baos)) {
                writer.setOutput(ios);
                writer.write(null, new IIOImage(finalImage, null, null), param);
            } finally {
                writer.dispose();
            }
            jpegBytes = baos.toByteArray();
        } catch (Exception e) {
            log.warn("지시서 썸네일 인코딩 실패 [{}]: {}", orderNumber, e.getMessage());
            return null;
        }

        String thumbKey = "orders/" + orderNumber + "/worksheet/" + UUID.randomUUID() + ".jpg";
        try {
            s3Client.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(thumbKey)
                            .contentType("image/jpeg")
                            // PDF 가 바뀌면 썸네일 키 자체가 새 UUID 라 캐시 무효화 자동 → 1년 immutable 안전.
                            .cacheControl("public, max-age=31536000, immutable")
                            .build(),
                    RequestBody.fromBytes(jpegBytes)
            );
        } catch (Exception e) {
            log.warn("지시서 썸네일 업로드 실패 [{}]: {}", orderNumber, e.getMessage());
            return null;
        }

        String normalizedPublicUrl = publicUrl == null || publicUrl.isBlank()
                ? ""
                : (publicUrl.endsWith("/") ? publicUrl : publicUrl + "/");
        return normalizedPublicUrl + thumbKey;
    }

    // R2 의 PDF public URL → key. publicUrl prefix 안 붙은 외부 URL 은 null.
    public String extractKey(String url) {
        if (url == null || url.isBlank()) return null;
        if (publicUrl == null || publicUrl.isBlank()) return null;
        String base = publicUrl.endsWith("/") ? publicUrl : publicUrl + "/";
        if (!url.startsWith(base)) return null;
        return url.substring(base.length());
    }

    // R2 객체를 메모리로 다운로드. 실패 시 null.
    public byte[] downloadObject(String key) {
        if (key == null || key.isBlank()) return null;
        try (ResponseInputStream<GetObjectResponse> in = s3Client.getObject(
                GetObjectRequest.builder().bucket(bucket).key(key).build()
        )) {
            return in.readAllBytes();
        } catch (Exception e) {
            log.warn("R2 객체 다운로드 실패 [{}]: {}", key, e.getMessage());
            return null;
        }
    }
}
