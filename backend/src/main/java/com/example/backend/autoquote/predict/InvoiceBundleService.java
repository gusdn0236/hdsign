package com.example.backend.autoquote.predict;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * 묶음(bundle) 조회 — 한 명세서와 같은 작업지시서를 공유하는 '형제 명세서'들을 돌려준다.
 *
 * <p>한 지시서(사진)가 쪼개져 여러 명세서로 청구되거나 한 명세서에 사진이 여러 장인 N:N 이 있어,
 * 단가찾아보기에서 한 후보 명세서를 열면 같은 묶음의 형제 명세서를 넘겨볼 수 있게 한다.
 *
 * <p>정본은 {@code bundles.json}(build_bundles.py 산출, 1-hop·엄격 게이트). 명세서 키로 색인돼
 * O(1) 조회. 사진/명세서는 기밀이라 {@link AutoQuoteDataSource}(파일시스템→비공개 R2)로만 읽고,
 * 각 형제의 grid·사진은 {@link InvoiceEvidenceService}로 하이드레이션한다(프론트 추가 왕복 없음).
 * bundles.json 이 형제로 가리키나 명세서를 못 찾으면(데이터 drift) 조용히 건너뛴다.
 */
@Service
public class InvoiceBundleService {

    /** 한 명세서당 형제 노출 상한(빌더 CAP 과 무관한 서빙측 안전망). */
    private static final int SIBLING_CAP = 20;

    private final AutoQuoteDataSource dataSource;
    private final InvoiceEvidenceService evidenceService;
    private final ObjectMapper json = new ObjectMapper();

    public InvoiceBundleService(AutoQuoteDataSource dataSource, InvoiceEvidenceService evidenceService) {
        this.dataSource = dataSource;
        this.evidenceService = evidenceService;
    }

    /** 형제 명세서 한 건: 공유 지시서 + 일치도 + (grid·사진을 채운) 근거. */
    public record Sibling(
            @JsonProperty("file") String file,
            @JsonProperty("idx") String idx,
            @JsonProperty("shared_photos") List<String> sharedPhotos,
            @JsonProperty("agreement") double agreement,
            @JsonProperty("evidence") InvoiceEvidenceService.Evidence evidence) {
    }

    /** 묶음 응답: 기준 명세서 키 + 그 명세서의 지시서 사진 + 형제들. */
    public record Bundle(
            @JsonProperty("bundle_id") String bundleId,
            @JsonProperty("photos") List<String> photos,
            @JsonProperty("siblings") List<Sibling> siblings) {
    }

    /** bundles.json 을 읽어 트리로. 미프로비저닝/파싱불가면 {@code null}. */
    private JsonNode loadBundles() {
        byte[] bytes = dataSource.load("bundles.json");
        if (bytes == null) {
            return null;
        }
        try {
            return json.readTree(bytes);
        } catch (Exception e) {
            return null;
        }
    }

    /** bundles.json 이 서빙 가능한가 — 컨트롤러가 503(미프로비저닝) 과 404(묶음 없음)를 가른다. */
    public boolean available() {
        return loadBundles() != null;
    }

    /**
     * {@code file#invoiceIdx} 명세서의 묶음을 만든다. 형제는 grid·사진까지 채워서 돌려준다.
     *
     * @return 묶음(형제 0건일 수도 있음), 해당 명세서가 어떤 묶음에도 없으면 {@code null}(컨트롤러 404).
     */
    public Bundle find(String file, String invoiceIdx) {
        JsonNode root = loadBundles();
        if (root == null) {
            return null;
        }
        JsonNode byInvoice = root.get("by_invoice");
        if (byInvoice == null || !byInvoice.isObject()) {
            return null;
        }
        String key = file + "#" + invoiceIdx;
        JsonNode entry = byInvoice.get(key);
        if (entry == null || entry.isNull()) {
            return null;
        }

        List<String> photos = new ArrayList<>();
        JsonNode photosNode = entry.get("photos");
        if (photosNode != null && photosNode.isArray()) {
            for (JsonNode p : photosNode) {
                photos.add(p.asText());
            }
        }

        List<Sibling> siblings = new ArrayList<>();
        JsonNode sibsNode = entry.get("siblings");
        if (sibsNode != null && sibsNode.isArray()) {
            for (JsonNode s : sibsNode) {
                if (siblings.size() >= SIBLING_CAP) {
                    break;
                }
                String sibFile = text(s, "file");
                String sibIdx = text(s, "idx");
                if (sibFile == null || sibIdx == null || !evidenceService.isValidFile(sibFile)) {
                    continue;
                }
                // 형제 명세서 grid + 지시서 사진을 채운다. 못 찾으면(데이터 drift) 건너뜀.
                InvoiceEvidenceService.Evidence ev = evidenceService.find(sibFile, sibIdx);
                if (ev == null) {
                    continue;
                }
                siblings.add(new Sibling(sibFile, sibIdx, textList(s, "shared_photos"),
                        s.path("agreement").asDouble(0.0), ev));
            }
        }
        return new Bundle(key, photos, siblings);
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    private static List<String> textList(JsonNode n, String field) {
        List<String> out = new ArrayList<>();
        JsonNode v = n.get(field);
        if (v != null && v.isArray()) {
            for (JsonNode e : v) {
                out.add(e.asText());
            }
        }
        return out;
    }
}
