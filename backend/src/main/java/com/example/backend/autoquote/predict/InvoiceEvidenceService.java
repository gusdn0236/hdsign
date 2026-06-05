package com.example.backend.autoquote.predict;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 견적 근거(과거 명세서) 조회. {@code easyform_*_*.json}({@code {invoices:[{invoice_idx,grid,...}]}})
 * 에서 특정 명세서의 grid 를 찾아 돌려주고, 가능하면 대표 작업지시서 사진 바이트를 곁들인다.
 *
 * <p>명세서/사진은 회사 기밀이라 {@link AutoQuoteDataSource}(파일시스템→비공개 R2) 로만 읽는다.
 * 사진은 {@code <명세서파일스템>_<invoiceIdx>.{jpg|jpeg|png}} 규칙으로 best-effort 조회하며,
 * 없으면 {@code photoAvailable=false} 로 grid 만 돌려준다(견적 근거 표시는 사진 없이도 동작).
 */
@Service
public class InvoiceEvidenceService {

    /** {@code file} 쿼리파라미터 화이트리스트: easyform_<year>_<kind>.json 형태만 허용. */
    private static final Pattern EASYFORM = Pattern.compile("easyform_[0-9A-Za-z_]+\\.json");

    private static final String[] PHOTO_EXTS = {"jpg", "jpeg", "png"};

    private final AutoQuoteDataSource dataSource;
    private final ObjectMapper json = new ObjectMapper();

    public InvoiceEvidenceService(AutoQuoteDataSource dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * 명세서 grid 한 줄. JSON 키는 명세서 컬럼 계약(snake_case)에 고정:
     * {@code item_code,item,spec,qty,unit_price}. 프론트(slice-11 근거패널)가 이 키를 소비한다.
     */
    public record GridRow(
            @JsonProperty("item_code") String itemCode,
            @JsonProperty("item") String item,
            @JsonProperty("spec") String spec,
            @JsonProperty("qty") String qty,
            @JsonProperty("unit_price") String unitPrice) {
    }

    /**
     * 근거 응답: 명세서 grid + (있으면) 작업지시서 사진(base64). JSON 키는 snake_case 로 고정
     * ({@code invoice_idx,file,date,client,total,grid,photo_available,photo_content_type,photo_base64}).
     * predict 응답과 동일하게 전역 네이밍전략 대신 필드별 {@link JsonProperty} 로 이 DTO 에만 국소 적용.
     */
    public record Evidence(
            @JsonProperty("invoice_idx") Object invoiceIdx,
            @JsonProperty("file") String file,
            @JsonProperty("date") String date,
            @JsonProperty("client") String client,
            @JsonProperty("total") String total,
            @JsonProperty("grid") List<GridRow> grid,
            @JsonProperty("photo_available") boolean photoAvailable,
            @JsonProperty("photo_content_type") String photoContentType,
            @JsonProperty("photo_base64") String photoBase64,
            // many-to-many: 한 명세서에 여러 지시서 사진(메인 + _2,_3..). 첫 장은 photo_base64 와 동일.
            @JsonProperty("photos") List<PhotoItem> photos) {
    }

    /** 사진 한 장(다장 응답용). */
    public record PhotoItem(
            @JsonProperty("content_type") String contentType,
            @JsonProperty("base64") String base64) {
    }

    /** 파일명이 화이트리스트(easyform_*.json)에 맞는가 — 컨트롤러가 400 판정에 쓴다. */
    public boolean isValidFile(String file) {
        return file != null && EASYFORM.matcher(file).matches();
    }

    /**
     * {@code file} 명세서에서 {@code invoiceIdx} 명세서를 찾아 근거를 만든다.
     *
     * @return 찾았으면 {@link Evidence}, 파일/명세서가 없으면 {@code null}(컨트롤러가 404 처리).
     */
    public Evidence find(String file, String invoiceIdx) {
        byte[] bytes = dataSource.load(file);
        if (bytes == null) {
            return null;
        }
        JsonNode root;
        try {
            root = json.readTree(bytes);
        } catch (Exception e) {
            return null;
        }
        JsonNode invoices = root.get("invoices");
        if (invoices == null || !invoices.isArray()) {
            return null;
        }
        for (JsonNode inv : invoices) {
            JsonNode idxNode = inv.get("invoice_idx");
            if (idxNode == null || !idxNode.asText().equals(invoiceIdx)) {
                continue;
            }
            return toEvidence(file, invoiceIdx, idxNode, inv);
        }
        return null;
    }

    private Evidence toEvidence(String file, String invoiceIdx, JsonNode idxNode, JsonNode inv) {
        List<GridRow> grid = new ArrayList<>();
        JsonNode gridNode = inv.get("grid");
        if (gridNode != null && gridNode.isArray()) {
            for (JsonNode g : gridNode) {
                grid.add(new GridRow(
                        text(g, "item_code"),
                        text(g, "item"),
                        text(g, "spec"),
                        text(g, "qty"),
                        text(g, "unit_price")));
            }
        }
        Object idx = idxNode.isNumber() ? (Object) idxNode.asInt() : idxNode.asText();
        List<Photo> photos = loadPhotos(file, invoiceIdx);
        Photo first = photos.isEmpty() ? null : photos.get(0);
        List<PhotoItem> items = new ArrayList<>();
        for (Photo p : photos) {
            items.add(new PhotoItem(p.contentType(), p.base64()));
        }
        return new Evidence(
                idx,
                file,
                text(inv, "date"),
                text(inv, "client"),
                text(inv, "total"),
                grid,
                first != null,
                first == null ? null : first.contentType(),
                first == null ? null : first.base64(),
                items);
    }

    /**
     * 작업지시서 사진들 조회: 메인 {@code <stem>_<idx>.{ext}} + 보조 {@code <stem>_<idx>_2.{ext}}, _3..
     * (many-to-many — 한 명세서에 여러 지시서). 메인이 없으면 빈 리스트(사진 없음).
     */
    private List<Photo> loadPhotos(String file, String invoiceIdx) {
        String stem = file.endsWith(".json") ? file.substring(0, file.length() - ".json".length()) : file;
        List<Photo> out = new ArrayList<>();
        Photo main = loadOne(stem + "_" + invoiceIdx);
        if (main == null) {
            return out;
        }
        out.add(main);
        for (int n = 2; n <= 6; n++) {
            Photo p = loadOne(stem + "_" + invoiceIdx + "_" + n);
            if (p == null) {
                break;
            }
            out.add(p);
        }
        return out;
    }

    /** {@code <base>.{jpg|jpeg|png}} best-effort 한 장 로드. */
    private Photo loadOne(String base) {
        for (String ext : PHOTO_EXTS) {
            byte[] bytes = dataSource.load(base + "." + ext);
            if (bytes != null && bytes.length > 0) {
                String ct = "png".equals(ext) ? "image/png" : "image/jpeg";
                return new Photo(ct, java.util.Base64.getEncoder().encodeToString(bytes));
            }
        }
        return null;
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return (v == null || v.isNull()) ? null : v.asText();
    }

    private record Photo(String contentType, String base64) {
    }
}
