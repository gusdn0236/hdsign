/**
 * 단가 데이터 — 빌드 번들에 포함된 prices.json 을 그대로 사용.
 *
 * 이전(v1)에는 백엔드 fetch 였는데 — 원본 ChannelCalc 처럼 정적 데이터로 동작하도록 회귀.
 * 백엔드가 떠있지 않아도 계산기 페이지는 항상 동작함.
 *
 * 가격 갱신 흐름:
 *   1) admin 이 /admin/prices 에서 엑셀 업로드 + 셀별 review
 *   2) 백엔드가 prices.json 을 디스크에 저장 (자동 .bak 백업)
 *   3) admin 이 새 prices.json 을 git 에 커밋 + 재배포
 *   4) 새 번들에서 이 import 가 갱신된 데이터를 잡음
 */
import prices from '../../../data/calc/prices.json'

export function usePrices() {
    return { prices, error: null }
}
