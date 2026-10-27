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
    // 흰 배경 판정 — RGB 모두 이 값 이상이면 "여백"으로 본다.
    private static final int WHITE_THRESHOLD = 245;
    // 크롭 경계에 도면 테두리가 바로 걸리면 잘려 보일 수 있어, 콘텐츠 짧은 변 기준으로 여유를 둔다.
    private static final double CROP_PADDING_RATIO = 0.03;
    // 모바일/관리자 카드(.ws-thumb-frame)의 고정 종횡비(1 / 1.414, A4 세로)와 정확히 맞춰야
    // 프론트 object-fit:contain 이 레터박스(위아래/좌우 여백) 없이 프레임을 꽉 채운다.
    // 잉크 bbox 를 이 비율로 '패딩해 확장'한 뒤 크롭하므로, 과한 원본 여백만 걷어내면서도
    // 결과물 종횡비는 항상 카드 프레임과 일치한다.
    private static final double TARGET_ASPECT_W_OVER_H = 1.0 / Math.sqrt(2);

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

        // 지시서 PDF 페이지 자체에 실제 도면보다 넓은 흰 여백이 있는 경우가 많아, 카드에
        // 전체 페이지를 넣으면 도면이 작게 보인다. 렌더된 래스터에서 잉크(비-흰색) bbox 를
        // 찾아 그만큼만 남기고 잘라낸다 — 방향(회전)과는 무관한 문제라 /Rotate 는 그대로 둔다.
        rendered = cropToContent(rendered);

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

    // 렌더된 페이지 래스터에서 흰 여백을 뺀 실제 도면(잉크) bbox 를 찾고, 카드 프레임과 같은
    // 종횡비(TARGET_ASPECT_W_OVER_H)가 되도록 중앙 기준으로 패딩해 확장한 뒤 크롭한다.
    // 그래야 프론트 object-fit:contain 이 레터박스 없이 프레임을 꽉 채우면서도, 원본 페이지에
    // 있던 과한 흰 여백만 제거된 상태로 보인다. 완전히 빈 페이지면 원본을 그대로 반환.
    private BufferedImage cropToContent(BufferedImage src) {
        int w = src.getWidth();
        int h = src.getHeight();
        if (w <= 0 || h <= 0) return src;

        int minX = w;
        int minY = h;
        int maxX = -1;
        int maxY = -1;
        int[] row = new int[w];
        for (int y = 0; y < h; y++) {
            src.getRGB(0, y, w, 1, row, 0, w);
            for (int x = 0; x < w; x++) {
                int rgb = row[x];
                int r = (rgb >> 16) & 0xFF;
                int g = (rgb >> 8) & 0xFF;
                int b = rgb & 0xFF;
                if (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < minX || maxY < minY) return src; // 완전히 빈 페이지

        double contentW = maxX - minX + 1;
        double contentH = maxY - minY + 1;
        double pad = Math.min(contentW, contentH) * CROP_PADDING_RATIO;
        double fMinX = Math.max(0, minX - pad);
        double fMinY = Math.max(0, minY - pad);
        double fMaxX = Math.min(w - 1, maxX + pad);
        double fMaxY = Math.min(h - 1, maxY + pad);

        double boxW = fMaxX - fMinX + 1;
        double boxH = fMaxY - fMinY + 1;
        double aspect = boxW / boxH;
        if (aspect > TARGET_ASPECT_W_OVER_H) {
            // 내용이 목표보다 옆으로 넓다 — 세로 패딩을 더해 키를 맞춘다.
            double targetH = boxW / TARGET_ASPECT_W_OVER_H;
            double addEach = (targetH - boxH) / 2;
            fMinY -= addEach;
            fMaxY += addEach;
        } else {
            // 내용이 목표보다 세로로 길다 — 가로 패딩을 더해 폭을 맞춘다.
            double targetW = boxH * TARGET_ASPECT_W_OVER_H;
            double addEach = (targetW - boxW) / 2;
            fMinX -= addEach;
            fMaxX += addEach;
        }

        // 확장이 이미지 경계를 벗어나면 반대쪽으로 밀어 넣어 크기를 최대한 보존한다
        // (한쪽이 페이지 끝에 막히면 다른 쪽에서라도 더 가져와 목표 종횡비에 최대한 가깝게).
        if (fMinX < 0) { fMaxX -= fMinX; fMinX = 0; }
        if (fMaxX > w - 1) { fMinX -= (fMaxX - (w - 1)); fMaxX = w - 1; }
        if (fMinY < 0) { fMaxY -= fMinY; fMinY = 0; }
        if (fMaxY > h - 1) { fMinY -= (fMaxY - (h - 1)); fMaxY = h - 1; }
        fMinX = Math.max(0, fMinX);
        fMinY = Math.max(0, fMinY);
        fMaxX = Math.min(w - 1, fMaxX);
        fMaxY = Math.min(h - 1, fMaxY);

        int cropX = (int) Math.floor(fMinX);
        int cropY = (int) Math.floor(fMinY);
        int cropW = (int) Math.floor(fMaxX) - cropX + 1;
        int cropH = (int) Math.floor(fMaxY) - cropY + 1;
        if (cropW <= 0 || cropH <= 0) return src;

        return src.getSubimage(cropX, cropY, cropW, cropH);
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
