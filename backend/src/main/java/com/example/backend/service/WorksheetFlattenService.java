package com.example.backend.service;

import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.springframework.stereotype.Service;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

/**
 * 작업지시서 PDF 의 각 페이지를 단일 JPEG 으로 재렌더한 새 PDF 를 만든다.
 *
 * <p>왜 필요한가:
 * 일러스트 → PDF24/FlexSign 변환본 중 일부가 투명도/효과 병합 과정에서 한 페이지의 그림을
 * 수백 개 비트맵 타일로 쪼갠다 (관찰 사례: 한 주문 PDF 가 258KB 인데 내부 /Image 객체 212 개).
 * pdf.js 가 이미지마다 ImageBitmap 디코드 + GPU 업로드 + 합성을 수행하는데, 갤럭시 등
 * 안드로이드 Chrome 은 누적 오버헤드에 완전히 멈춘다(아이폰 Safari 는 메모리 관리 / Metal
 * 가속이 달라 견딤).
 *
 * <p>페이지당 단일 이미지 구조로 평탄화하면 안드로이드에서도 즉시 렌더되고, 모바일 뷰어는
 * 이미 textLayer/annotationLayer 를 끈 상태라 텍스트 선택/검색 같은 사용성 손실은 없다.
 *
 * <p>DPI 300 + JPEG 품질 0.88: A4 → 2480x3508px, 핀치 5x 까지 또렷.
 * 신규 PDF 업로드 ({@link com.example.backend.controller.PublicEvidenceController}) 와
 * 기존 PDF 백필 ({@link com.example.backend.controller.AdminOrderController#backfillWorksheetFlatten})
 * 양쪽에서 사용.
 */
@Slf4j
@Service
public class WorksheetFlattenService {

    private static final float FLATTEN_DPI = 300f;
    private static final float FLATTEN_JPEG_QUALITY = 0.88f;

    /**
     * 입력 PDF 바이트를 평탄화한 새 PDF 바이트로 반환. 실패 시 null —
     * 호출부는 원본 그대로 사용 (업로드 자체는 절대 막지 않는다).
     */
    public byte[] flatten(byte[] pdfBytes) {
        if (pdfBytes == null || pdfBytes.length == 0) return null;
        try (PDDocument src = Loader.loadPDF(pdfBytes); PDDocument dst = new PDDocument()) {
            int pageCount = src.getNumberOfPages();
            if (pageCount == 0) return null;
            PDFRenderer renderer = new PDFRenderer(src);
            for (int i = 0; i < pageCount; i++) {
                // PDFRenderer 는 /Rotate 를 자동 적용한 표시 방향 픽셀맵을 만든다 — 새 PDF 는
                // 회전 0 으로 두고, 픽셀 차원을 그대로 PDF 포인트로 환산해 페이지 크기 산정.
                BufferedImage rendered = renderer.renderImageWithDPI(i, FLATTEN_DPI, ImageType.RGB);
                float pageW = rendered.getWidth() * 72f / FLATTEN_DPI;
                float pageH = rendered.getHeight() * 72f / FLATTEN_DPI;
                PDPage newPage = new PDPage(new PDRectangle(pageW, pageH));
                dst.addPage(newPage);
                PDImageXObject jpeg = JPEGFactory.createFromImage(dst, rendered, FLATTEN_JPEG_QUALITY);
                try (PDPageContentStream cs = new PDPageContentStream(dst, newPage)) {
                    cs.drawImage(jpeg, 0, 0, pageW, pageH);
                }
            }
            try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                dst.save(out);
                return out.toByteArray();
            }
        } catch (Exception e) {
            log.warn("PDF 평탄화 실패: {}", e.getMessage());
            return null;
        }
    }
}
