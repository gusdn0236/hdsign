package com.example.backend.controller;

import com.example.backend.entity.LedTrainingSample;

import java.util.ArrayList;
import java.util.List;

/**
 * LED 개수 회귀계수 최소제곱 적합기(절편 없는 2변수 모델 {@code count ≈ area*A + perim*B}).
 *
 * <p>외부 수학 라이브러리 없이 2x2 정규방정식을 행렬식으로 직접 푼다. 이상치 제거(1회 재적합),
 * 제약(A>0, B>=0), 그리고 LED 1개당 면적/둘레로의 변환까지 한 곳에 모았다.
 * {@link LedTrainingController} 전용 보조 클래스(package-private).
 */
final class LedCoeffFitter {

    private LedCoeffFitter() {
    }

    /** 행렬식이 사실상 0인지 판단하는 임계값(특이/공선 데이터 → 면적 단독 적합으로 폴백). */
    private static final double DET_EPS = 1e-12;

    /** B(둘레계수)가 사실상 0인지 판단하는 임계값(이하면 둘레 무한대 → perimPerLed 를 큰 수로). */
    private static final double B_EPS = 1e-9;

    /** 이상치 컷오프 배수: |잔차| > 2.5*RMSE 인 행을 제거. */
    private static final double OUTLIER_K = 2.5;

    /**
     * 한 LED 타입의 샘플들로 계수를 적합한다. 샘플이 {@code minSamples} 미만이거나
     * 적합이 퇴화(A<=0)하면 {@code null} 을 반환해 호출자가 응답에서 그 타입을 생략하게 한다.
     */
    static LedTrainingController.Coeff fit(List<LedTrainingSample> rows, int minSamples) {
        if (rows == null || rows.size() < minSamples) {
            return null;
        }

        // 면적/둘레/개수 배열 추출.
        int n0 = rows.size();
        double[] area = new double[n0];
        double[] perim = new double[n0];
        double[] count = new double[n0];
        for (int i = 0; i < n0; i++) {
            LedTrainingSample r = rows.get(i);
            area[i] = r.getArea();
            perim[i] = r.getPerim();
            count[i] = r.getActualCount();
        }

        // 전체 인덱스로 1차 적합.
        int[] all = range(n0);
        double[] ab = solve(area, perim, count, all);

        // 1차 적합 잔차 → RMSE → 이상치(|r|>2.5*RMSE) 제거.
        double sumSq = 0.0;
        for (int i : all) {
            double r = count[i] - (ab[0] * area[i] + ab[1] * perim[i]);
            sumSq += r * r;
        }
        double rmse = Math.sqrt(sumSq / all.length);

        List<Integer> survivorsList = new ArrayList<>();
        double cutoff = OUTLIER_K * rmse;
        for (int i : all) {
            double r = count[i] - (ab[0] * area[i] + ab[1] * perim[i]);
            if (Math.abs(r) <= cutoff) {
                survivorsList.add(i);
            }
        }

        // 생존자가 충분하면 그들로 1회 재적합, 아니면 1차 적합 유지.
        int[] used = all;
        if (survivorsList.size() >= minSamples && survivorsList.size() < n0) {
            used = toArray(survivorsList);
            ab = solve(area, perim, count, used);
        }

        double A = ab[0];
        double B = ab[1];

        // 제약: B>=0. 음수면 0 으로 고정하고 면적 단독으로 재적합(A = Sca/Saa).
        if (B < 0) {
            B = 0.0;
            double Saa = 0.0, Sca = 0.0;
            for (int i : used) {
                Saa += area[i] * area[i];
                Sca += count[i] * area[i];
            }
            A = (Saa > 0) ? (Sca / Saa) : 0.0;
        }

        // 제약: A>0. 퇴화면 타입 생략.
        if (A <= 0) {
            return null;
        }

        double areaPerLed = 1.0 / A;
        double perimPerLed = (B > B_EPS) ? (1.0 / B) : 1.0e9;
        return new LedTrainingController.Coeff(areaPerLed, perimPerLed, used.length);
    }

    /**
     * 절편 없는 2변수 최소제곱: 정규방정식 [[Saa,Sap],[Sap,Spp]]·[A,B]=[Sca,Scp] 를 행렬식으로 푼다.
     * 행렬식이 사실상 0(공선/특이)이면 면적 단독 적합({@code A=Sca/Saa, B=0})으로 폴백한다.
     */
    private static double[] solve(double[] area, double[] perim, double[] count, int[] idx) {
        double Saa = 0, Sap = 0, Spp = 0, Sca = 0, Scp = 0;
        for (int i : idx) {
            Saa += area[i] * area[i];
            Sap += area[i] * perim[i];
            Spp += perim[i] * perim[i];
            Sca += count[i] * area[i];
            Scp += count[i] * perim[i];
        }
        double det = Saa * Spp - Sap * Sap;
        if (Math.abs(det) < DET_EPS) {
            double A = (Saa > 0) ? (Sca / Saa) : 0.0;
            return new double[]{A, 0.0};
        }
        double A = (Sca * Spp - Scp * Sap) / det;
        double B = (Saa * Scp - Sap * Sca) / det;
        return new double[]{A, B};
    }

    private static int[] range(int n) {
        int[] a = new int[n];
        for (int i = 0; i < n; i++) {
            a[i] = i;
        }
        return a;
    }

    private static int[] toArray(List<Integer> list) {
        int[] a = new int[list.size()];
        for (int i = 0; i < a.length; i++) {
            a[i] = list.get(i);
        }
        return a;
    }
}
