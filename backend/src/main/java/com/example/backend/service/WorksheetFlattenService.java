package com.example.backend.service;

import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.springframework.stereotype.Service;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

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
 * <p><b>두 갈래 처리.</b> 워처가 지시서 텍스트를 윤곽선(벡터 커브)으로 저장하므로 보통 지시서는
 * 이미지 0~1개의 사실상 벡터 PDF 다(참고사진 1장 정도만 래스터).
 * <ul>
 *   <li><b>이미지 ≤ {@link #TILE_FLATTEN_THRESHOLD} (일반):</b> 전체 페이지를 굽지 않는다 —
 *       선명한 벡터 텍스트를 저해상 JPEG 으로 뭉개고 용량↑·OOM 위험만 생기기 때문. 대신
 *       <b>큰 참고사진(래스터 이미지)만 골라 {@link #IMAGE_TARGET_DIM} 급으로 다운샘플</b>하고
 *       벡터는 그대로 둔다(텍스트 선명 + 용량↓ + 모바일 렌더 빠름 + 썸네일/업로드 OOM 제거).
 *       줄일 큰 이미지가 없으면 {@code null} → 호출부가 원본 그대로 사용.</li>
 *   <li><b>이미지 &gt; 임계값 (타일 폭탄):</b> 한 페이지가 수백 개 비트맵 타일로 쪼개져 안드로이드
 *       pdf.js 가 멈추는 병리적 케이스 — 이때만 페이지당 단일 JPEG 으로 전체 재렌더한다.</li>
 * </ul>
 * 다운샘플 디코드는 서브샘플링({@code getImage(null, factor)})으로 — 거대 이미지를 풀디코드하지
 * 않아 OOM 을 원천 차단한다. 마스크/투명 이미지는 JPEG 재인코딩 시 알파가 사라지므로 건너뛴다.
 *
 * <p>DPI 400 + JPEG 품질 0.95: A4 → 3307x4677px, 화면/핀치 ~350% 까지 또렷.
 * (한때 600 으로 올렸으나 A4 한 페이지 INT_RGB 래스터가 ~139MB 라 Railway 힙(MaxRAMPercentage=75,
 *  512MB 컨테이너 → ~384MB)에서 OOM → -XX:+ExitOnOutOfMemoryError 로 컨테이너가 즉사하며
 *  worksheet-pdf 업로드가 전부 실패했다. 400 은 ~62MB 라 안전. 더 올리려면 힙부터 키워야 함.)
 * 추가로 MAX_RENDER_PIXELS 로 페이지별 DPI 를 적응 하향해 A4 보다 큰 대형 지시서도 OOM 안 나게 한다.
 * 신규 PDF 업로드 ({@link com.example.backend.controller.PublicEvidenceController}) 와
 * 기존 PDF 백필 ({@link com.example.backend.controller.AdminOrderController#backfillWorksheetFlatten})
 * 양쪽에서 사용.
 */
@Slf4j
@Service
public class WorksheetFlattenService {

    private static final float FLATTEN_DPI = 400f;
    private static final float FLATTEN_JPEG_QUALITY = 0.95f;
    // 이미지 XObject 수가 이 값 이하면 평탄화하지 않고 원본을 쓴다(null 반환). 일반 지시서는 0~1개,
    // 안드로이드를 멈추게 했던 병리적 케이스는 한 페이지에 /Image 212개였다. 12 는 손으로 붙인
    // 참고사진 몇 장은 원본 그대로 두면서(선명·경량), 수십~수백 타일 폭탄만 평탄화로 잡는 경계.
    private static final int TILE_FLATTEN_THRESHOLD = 12;
    // 페이지 하나를 렌더한 BufferedImage(INT_RGB, 4 byte/px)의 픽셀 수 상한.
    // A4 @400DPI ≈ 15.5M px(~62MB). 16M 을 넘는 큰 페이지는 이 픽셀 예산에 맞춰 DPI 를 낮춰
    // 단일 페이지 래스터가 힙을 넘기지 않게 한다. (대형 사인 도안 등 A4 초과 페이지 방어.)
    private static final double MAX_RENDER_PIXELS = 16_000_000d;
    // 참고사진(래스터 이미지) 다운샘플: 가장 긴 변이 이 px 를 넘는 이미지만 줄인다.
    private static final int IMAGE_DOWNSAMPLE_TRIGGER = 2000;
    // 다운샘플 목표(가장 긴 변). A4 폭 기준 ~180dpi — 참고용 사진엔 충분하고 모바일에서 가볍다.
    private static final int IMAGE_TARGET_DIM = 1500;
    // 다운샘플 재인코딩 JPEG 품질. 참고사진이라 약간 낮춰 용량을 더 줄인다.
    private static final float IMAGE_JPEG_QUALITY = 0.82f;

    /**
     * 입력 PDF 바이트를 평탄화한 새 PDF 바이트로 반환. 실패 시 null —
     * 호출부는 원본 그대로 사용 (업로드 자체는 절대 막지 않는다).
     */
    public byte[] flatten(byte[] pdfBytes) {
        if (pdfBytes == null || pdfBytes.length == 0) return null;
        try (PDDocument src = Loader.loadPDF(pdfBytes)) {
            int pageCount = src.getNumberOfPages();
            if (pageCount == 0) return null;
            int imageCount = countImageXObjects(src);
            if (imageCount > TILE_FLATTEN_THRESHOLD) {
                // 타일 폭탄 — 페이지당 단일 JPEG 으로 전체 재렌더해 안드로이드 pdf.js 멈춤을 막는다.
                log.info("지시서 전체 평탄화 — 이미지 타일 {}개 > {} (안드로이드 멈춤 방어)",
                        imageCount, TILE_FLATTEN_THRESHOLD);
                return rasterizeWholePages(src, pageCount);
            }
            // 일반(사실상 벡터) 지시서 — 텍스트는 벡터 그대로 두고 큰 참고사진만 다운샘플.
            boolean changed = downsampleLargeImages(src);
            if (!changed) {
                log.info("지시서 다운샘플 불필요 — 이미지 {}개, 모두 작음 (원본 그대로 사용)", imageCount);
                return null;
            }
            try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                src.save(out);
                log.info("지시서 이미지 다운샘플 완료 — 큰 참고사진 축소(벡터 텍스트 보존)");
                return out.toByteArray();
            }
        } catch (Throwable e) {
            // Exception 뿐 아니라 Error(StackOverflowError 등)도 잡아 원본 폴백 — 평탄화는
            // 어떤 경우에도 업로드를 막지 않는다는 계약을 지킨다. (단, 진짜 OOM 은 Dockerfile 의
            // -XX:+ExitOnOutOfMemoryError 가 catch 보다 먼저 JVM 을 종료시키므로 여기 도달 못 한다 —
            // 그래서 다운샘플 서브샘플링/DPI·픽셀 상한으로 OOM 자체를 안 나게 막는 게 1차 방어선이다.)
            log.warn("PDF 평탄화/다운샘플 실패: {}", e.toString());
            return null;
        }
    }

    /** 페이지당 단일 JPEG 으로 전체 재렌더(타일 폭탄 전용). DPI/픽셀 상한으로 OOM 차단. */
    private static byte[] rasterizeWholePages(PDDocument src, int pageCount) throws Exception {
        try (PDDocument dst = new PDDocument()) {
            PDFRenderer renderer = new PDFRenderer(src);
            for (int i = 0; i < pageCount; i++) {
                // PDFRenderer 는 /Rotate 를 자동 적용한 표시 방향 픽셀맵을 만든다 — 새 PDF 는
                // 회전 0 으로 두고, 픽셀 차원을 그대로 PDF 포인트로 환산해 페이지 크기 산정.
                float dpi = effectiveDpi(src.getPage(i).getCropBox());
                BufferedImage rendered = renderer.renderImageWithDPI(i, dpi, ImageType.RGB);
                float pageW = rendered.getWidth() * 72f / dpi;
                float pageH = rendered.getHeight() * 72f / dpi;
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
        }
    }

    /**
     * 페이지 크기(points)를 받아, 렌더 픽셀 수가 {@link #MAX_RENDER_PIXELS} 를 넘지 않는
     * 안전 DPI 를 반환. 보통은 {@link #FLATTEN_DPI} 그대로지만 A4 보다 큰 페이지는 하향한다.
     */
    private static float effectiveDpi(PDRectangle cropBox) {
        float wIn = cropBox.getWidth() / 72f;
        float hIn = cropBox.getHeight() / 72f;
        double areaIn2 = (double) wIn * hIn;
        if (areaIn2 <= 0) return FLATTEN_DPI;
        double maxDpi = Math.sqrt(MAX_RENDER_PIXELS / areaIn2);
        return (float) Math.min(FLATTEN_DPI, maxDpi);
    }

    /** 모든 페이지의 이미지 XObject 총수(폼 XObject 안에 중첩된 것도 포함). 픽셀 디코드는 안 함 — 싸다. */
    private static int countImageXObjects(PDDocument doc) {
        int count = 0;
        for (PDPage page : doc.getPages()) {
            count += countImagesInResources(page.getResources(), 0);
        }
        return count;
    }

    private static int countImagesInResources(PDResources res, int depth) {
        // 깊이 제한 — 비정상적으로 깊거나 순환 참조하는 폼 중첩에서 무한 재귀 방지.
        if (res == null || depth > 6) return 0;
        int count = 0;
        for (COSName name : res.getXObjectNames()) {
            try {
                PDXObject xo = res.getXObject(name);
                if (xo instanceof PDImageXObject) {
                    count += 1;
                } else if (xo instanceof PDFormXObject form) {
                    count += countImagesInResources(form.getResources(), depth + 1);
                }
            } catch (Exception e) {
                // 한 객체 해석 실패는 무시하고 계속 — 카운트는 임계값 판정용 근사치면 충분.
            }
        }
        return count;
    }

    /**
     * 페이지의 큰 래스터 이미지(참고사진 등)만 {@link #IMAGE_TARGET_DIM} 급으로 다운샘플한다.
     * 벡터 텍스트/도형은 손대지 않는다. 한 장이라도 줄였으면 true.
     * <p>디코드는 서브샘플링({@code getImage(null, factor)})으로 — 거대 이미지를 풀디코드하지 않아
     * OOM 을 막는다. 마스크/소프트마스크/스텐실(투명) 이미지는 JPEG 재인코딩 시 알파가 사라져
     * 화면이 깨지므로 건너뛴다(안전 우선). 폼 XObject 안의 이미지는 대상에서 제외(참고사진은
     * 보통 페이지 리소스에 직접 놓인다).
     */
    private static boolean downsampleLargeImages(PDDocument doc) {
        boolean changed = false;
        for (PDPage page : doc.getPages()) {
            PDResources res = page.getResources();
            if (res == null) continue;
            COSBase xobjBase = res.getCOSObject().getDictionaryObject(COSName.XOBJECT);
            if (!(xobjBase instanceof COSDictionary xobjDict)) continue;
            // 이름을 먼저 모아둔다 — 값 교체 중 동시수정 회피.
            List<COSName> names = new ArrayList<>();
            for (COSName n : res.getXObjectNames()) names.add(n);
            for (COSName name : names) {
                PDXObject xo;
                try { xo = res.getXObject(name); } catch (Exception e) { continue; }
                if (!(xo instanceof PDImageXObject img)) continue;
                try {
                    if (img.isStencil()) continue;
                    if (img.getSoftMask() != null) continue;
                    if (img.getCOSObject().getDictionaryObject(COSName.MASK) != null) continue;
                    int longest = Math.max(img.getWidth(), img.getHeight());
                    if (longest <= IMAGE_DOWNSAMPLE_TRIGGER) continue;
                    int subsample = Math.max(1, longest / IMAGE_TARGET_DIM);
                    BufferedImage decoded = img.getImage(null, subsample); // 서브샘플 디코드(메모리 제한)
                    if (decoded == null) continue;
                    BufferedImage rgb = toOpaqueRgb(decoded);
                    if (Math.max(rgb.getWidth(), rgb.getHeight()) > IMAGE_TARGET_DIM) {
                        rgb = scaleToLongest(rgb, IMAGE_TARGET_DIM);
                    }
                    PDImageXObject newImg = JPEGFactory.createFromImage(doc, rgb, IMAGE_JPEG_QUALITY);
                    xobjDict.setItem(name, newImg.getCOSObject()); // 같은 이름에 저해상 이미지로 교체
                    changed = true;
                } catch (Throwable e) {
                    // 한 이미지 실패는 건너뛴다 — 원본 이미지가 그대로 남아 렌더는 정상.
                }
            }
        }
        return changed;
    }

    /** JPEG 인코딩 가능한 알파 없는 TYPE_INT_RGB 로 보정(흰 배경 위에 그림). */
    private static BufferedImage toOpaqueRgb(BufferedImage in) {
        if (in.getType() == BufferedImage.TYPE_INT_RGB) return in;
        BufferedImage out = new BufferedImage(in.getWidth(), in.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, out.getWidth(), out.getHeight());
        g.drawImage(in, 0, 0, null);
        g.dispose();
        return out;
    }

    /** 가장 긴 변이 targetLongest 가 되도록 비율 유지 축소. */
    private static BufferedImage scaleToLongest(BufferedImage in, int targetLongest) {
        int w = in.getWidth(), h = in.getHeight();
        double s = (double) targetLongest / Math.max(w, h);
        int nw = Math.max(1, (int) Math.round(w * s));
        int nh = Math.max(1, (int) Math.round(h * s));
        BufferedImage out = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(in, 0, 0, nw, nh, null);
        g.dispose();
        return out;
    }
}
