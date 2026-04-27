package com.example.backend.util;

import java.text.Normalizer;

/**
 * 한글 자모 단위 유사도 계산 유틸 — 거래처 가입 검색에서
 * "디엔에스" ↔ "디앤에스", "디자인H" ↔ "디자인에이치" 같은 표기 차이를 잡기 위함.
 *
 * 핵심 아이디어: 한글 음절을 초/중/종성 자모 시퀀스로 펼친 뒤 Levenshtein 편집거리.
 * "ㅔ ↔ ㅐ" 차이가 자모 1개 차이로 떨어지므로 음절 단위 비교보다 훨씬 관대하다.
 */
public final class HangulSimilarity {

    private static final int HANGUL_BASE = 0xAC00;
    private static final int HANGUL_END  = 0xD7A3;

    private HangulSimilarity() {}

    /** NFC + 공백 제거 + 소문자 + 한글 음절 → 초/중/종 자모 분해. 비한글은 그대로 통과. */
    public static String decomposeToJamo(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s, Normalizer.Form.NFC).toLowerCase();
        StringBuilder sb = new StringBuilder(n.length() * 3);
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (Character.isWhitespace(c)) continue;
            if (c >= HANGUL_BASE && c <= HANGUL_END) {
                int idx = c - HANGUL_BASE;
                int initial = idx / 588;        // 초성 0..18
                int medial  = (idx % 588) / 28; // 중성 0..20
                int finalC  = idx % 28;         // 종성 0..27 (0=없음)
                sb.append((char) (0x1100 + initial));
                sb.append((char) (0x1161 + medial));
                if (finalC != 0) sb.append((char) (0x11A7 + finalC));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** 두 문자열 간 Levenshtein 편집거리 (단순 DP, 1D 배열 두개 회전). */
    public static int levenshtein(String a, String b) {
        if (a == null) a = "";
        if (b == null) b = "";
        int la = a.length(), lb = b.length();
        if (la == 0) return lb;
        if (lb == 0) return la;
        int[] prev = new int[lb + 1];
        int[] cur  = new int[lb + 1];
        for (int j = 0; j <= lb; j++) prev[j] = j;
        for (int i = 1; i <= la; i++) {
            cur[0] = i;
            char ca = a.charAt(i - 1);
            for (int j = 1; j <= lb; j++) {
                int cost = (ca == b.charAt(j - 1)) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] tmp = prev; prev = cur; cur = tmp;
        }
        return prev[lb];
    }

    /** 자모 분해 후 절대 편집거리. */
    public static int jamoDistance(String query, String candidate) {
        return levenshtein(decomposeToJamo(query), decomposeToJamo(candidate));
    }

    /** 자모 길이 대비 편집거리 비율 (0.0 = 완전일치, 1.0 = 전혀 다름). */
    public static double similarityRatio(String query, String candidate) {
        String a = decomposeToJamo(query);
        String b = decomposeToJamo(candidate);
        int max = Math.max(a.length(), b.length());
        if (max == 0) return 1.0;
        return (double) levenshtein(a, b) / max;
    }

    /** 자모 시퀀스에서 부분일치 여부 (한쪽이 다른쪽을 substring 으로 포함). */
    public static boolean containsAsJamo(String query, String candidate) {
        String a = decomposeToJamo(query);
        String b = decomposeToJamo(candidate);
        if (a.length() < 4 || b.length() < 4) return false; // 너무 짧으면 노이즈
        return b.contains(a) || a.contains(b);
    }
}
