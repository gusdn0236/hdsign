/**
 * LED 개수 학습(feedback loop) 클라이언트 — JWT 백엔드 read/write.
 *
 * 사장님이 LED계산 모달에서 벡터를 고르고 Ctrl+F8 로 '실제로 넣은 개수'를 입력하면
 *   POST /api/admin/autoquote/led-samples   (글자별 {면적,둘레,실제개수,종류} 누적 저장)
 *   GET  /api/admin/autoquote/led-coeffs     (종류별 자동 피팅된 계수 로드)
 * 를 호출한다. 서버가 쌓인 표본으로 `개수 = 면적/areaPerLed + 둘레/perimPerLed` 를
 * 최소제곱 피팅(이상치 제외)해서 돌려주고, 프론트는 그 값으로 ledLayout 의 기본계수를
 * 덮어쓴다 → 데이터가 쌓일수록 LED계산이 실제 설치 개수에 자동으로 가까워진다.
 *
 * ★ 이 루프는 클로드(AI)·외부 API 를 전혀 안 쓴다. 전부 백엔드의 순수 산술이라
 *   구독과 무관하게 무료로 영구 작동한다(소스코드는 안 바뀌고 계수 '값'만 학습됨).
 *
 * corpusClient 와 동일한 BASE_URL + Bearer 패턴. 계수는 다른 PC 에서도 실시간으로
 * 쌓이므로 캐시를 두지 않는다 — 마운트 시 1회 로드 + 저장 후 재요청.
 */
import { BASE_URL } from './corpusClient';

const SAMPLES_URL = '/api/admin/autoquote/led-samples';
const COEFFS_URL = '/api/admin/autoquote/led-coeffs';

/** 한 글자(run)의 학습 표본 — 서버 LedTrainingController.Sample 과 일치. */
export interface LedSample {
  ledType: string;
  area: number; // mm²
  perim: number; // mm
  actualCount: number; // 실제로 넣은 개수
  orderNumber?: string | null;
  polysJson?: string | null; // 원본 벡터(나중에 더 정교한 모델로 재피팅용)
}

/** 종류별 학습된 계수 — ledLayout 의 areaPerLed/perimPerLed 를 덮어쓴다. */
export interface LedCoeff {
  areaPerLed: number;
  perimPerLed: number;
  n: number; // 사용된 표본 수(이상치 제외 후)
}

function authHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 실측 표본들을 서버에 누적 저장. 저장된 개수를 반환. */
export async function postLedSamples(token: string | null | undefined, samples: LedSample[]): Promise<number> {
  const res = await fetch(`${BASE_URL}${SAMPLES_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ samples }),
  });
  if (!res.ok) {
    throw new Error(`실측 개수를 저장하지 못했습니다 (${res.status}).`);
  }
  const body = (await res.json()) as { saved?: number } | null;
  return body?.saved ?? 0;
}

/**
 * 종류별 자동 피팅 계수 로드. 표본이 충분(≥6)한 종류만 내려온다 — 나머지는 호출측이
 * ledLayout 의 내장 기본값을 그대로 쓰면 된다. 실패하면 빈 객체(기본값 유지).
 */
export async function loadLedCoeffs(token?: string | null): Promise<Record<string, LedCoeff>> {
  try {
    const res = await fetch(`${BASE_URL}${COEFFS_URL}`, { headers: authHeaders(token) });
    if (!res.ok) return {};
    const body = (await res.json()) as { coeffs?: Record<string, LedCoeff> } | null;
    return body?.coeffs ?? {};
  } catch {
    return {}; // 네트워크 실패 시 조용히 기본값 유지(LED계산은 계속 동작).
  }
}
