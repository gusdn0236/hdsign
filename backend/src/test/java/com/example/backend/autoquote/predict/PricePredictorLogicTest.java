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
        assertThat(PricePredictor.sizeVal("간판", "1000x500")).isEqualTo(500000L);
        assertThat(PricePredictor.sizeVal("간판", "1000*500")).isEqualTo(500000L);
        // h:NNN → NNN^2.
        assertThat(PricePredictor.sizeVal("간판", "h:300")).isEqualTo(90000L);
        assertThat(PricePredictor.sizeVal("간판", "h 300")).isEqualTo(90000L);
        // 단일 숫자 → NNN^2.
        assertThat(PricePredictor.sizeVal("간판250", "")).isEqualTo(62500L);
        // 숫자 없음 → null.
        assertThat(PricePredictor.sizeVal("간판", "")).isNull();
    }

    @Test
    void sizeVal_fiveDigitDimension_doesNotOverflow() {
        // 5자리 치수의 v*v(=2.5e9)는 int 범위(2.147e9)를 넘는다 — long 이라야 양수로 보존된다.
        // (int 였다면 오버플로로 음수가 되어 하류에서 sqrt(neg)=NaN → price=0 이 됐다.)
        assertThat(PricePredictor.sizeVal("현수막 50000", "")).isEqualTo(2_500_000_000L);
        assertThat(PricePredictor.sizeVal("간판", "50000*3000")).isEqualTo(150_000_000L);
        assertThat(PricePredictor.sizeVal("현수막 50000", "")).isGreaterThan(0L);
    }
}
