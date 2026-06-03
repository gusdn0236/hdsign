package com.example.backend.autoquote.predict;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code build_learn_corpus.py} 에서 포팅한 정규화/토큰/사이즈 함수가 파이썬과 동일하게 동작하는지
 * 핀으로 박는 단위 테스트(가격 예측 정확도의 기반).
 */
class PricePredictorLogicTest {

    @Test
    void cnorm_lowercasesAndStripsCompanyAndPunctuation() {
        // (주)/주식회사 제거 + 영숫자/한글만 남김.
        assertThat(PricePredictor.cnorm("(주)한국사인")).isEqualTo("한국사인");
        assertThat(PricePredictor.cnorm("한국사인 주식회사")).isEqualTo("한국사인");
        assertThat(PricePredictor.cnorm("ABC-광고!")).isEqualTo("abc광고");
        assertThat(PricePredictor.cnorm(null)).isEqualTo("");
    }

    @Test
    void inorm_dropsDigitsKeepsItemKind() {
        // 숫자(사이즈) 제거 → 품목 종류만.
        assertThat(PricePredictor.inorm("채널간판300")).isEqualTo("채널간판");
        assertThat(PricePredictor.inorm("Flex 1000x500")).isEqualTo("flexx");
        assertThat(PricePredictor.inorm("123")).isEqualTo("");
    }

    @Test
    void itoks_extractsLength2PlusLetterTokens() {
        // 길이≥2 영문/한글 토큰만(숫자/한 글자 제외).
        assertThat(PricePredictor.itoks("채널간판", "h:300"))
                .containsExactly("채널간판");
        assertThat(PricePredictor.itoks("LED 채널", "아크릴 5T"))
                .contains("led", "채널", "아크릴");
    }

    @Test
    void sizeVal_parsesAreaHeightAndBareNumber() {
        // AxB 면적.
        assertThat(PricePredictor.sizeVal("간판", "1000x500")).isEqualTo(500000);
        assertThat(PricePredictor.sizeVal("간판", "1000*500")).isEqualTo(500000);
        // h:NNN → NNN^2.
        assertThat(PricePredictor.sizeVal("간판", "h:300")).isEqualTo(90000);
        assertThat(PricePredictor.sizeVal("간판", "h 300")).isEqualTo(90000);
        // 단일 숫자 → NNN^2.
        assertThat(PricePredictor.sizeVal("간판250", "")).isEqualTo(62500);
        // 숫자 없음 → null.
        assertThat(PricePredictor.sizeVal("간판", "")).isNull();
    }
}
