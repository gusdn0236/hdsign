/**
 * @slice-3 자동견적 공유 보정(correction) 클라이언트 — JWT 백엔드 read/write.
 *
 * 한 직원이 견적 라인의 단가를 수정하고 "왜"를 적으면 이 클라이언트가
 *   GET  /api/admin/autoquote/corrections   (전체 공유 보정 로드)
 *   POST /api/admin/autoquote/corrections   (새 보정 저장)
 * 를 호출한다. 저장된 보정은 모든 직원의 다음 견적에서 견적엔진의 TOP prior 로
 * 되살아난다(engine `findCorrection` 이 category + sizeBucket 으로 매칭).
 *
 * 보안: author 는 절대 클라이언트가 보내지 않는다 — 서버가 인증된 principal(JWT)
 * 에서 박는다(스푸핑 불가). 본문은 featureKey/correctedUnitPrice/explanation(+선택
 * priority)만 싣는다(백엔드 {@code CorrectionRequest} 와 일치).
 *
 * corpusClient 와 동일한 BASE_URL + Bearer 패턴을 따른다. 단, 보정은 다른 직원이
 * 실시간으로 추가하므로 모듈 캐시를 두지 않는다 — 매 호출이 최신을 가져오고
 * (mount 시 lazy-fetch · 저장 후 재요청), 그래야 한 명의 보정이 모두에게 즉시 반영된다.
 */
import type { Correction } from '../engine';
import { BASE_URL } from './corpusClient';

const CORRECTIONS_URL = '/api/admin/autoquote/corrections';

/** 백엔드 CorrectionResponse 의 한 레코드(저장된 보정의 노출 필드). */
interface RawCorrection {
  id: number | string;
  featureKey: string;
  /** BigDecimal 이 JSON 으로 number 또는 string 으로 올 수 있음 → Number() 정규화. */
  correctedUnitPrice: number | string;
  explanation: string;
  author?: string;
  priority?: number;
  createdAt?: string;
}

/** POST 본문 — author 는 의도적으로 없다(서버가 principal 로 채움). */
export interface NewCorrection {
  featureKey: string;
  correctedUnitPrice: number;
  explanation: string;
  /** 생략 시 서버 기본값. 상급자/공유 우선순위 가중에 사용. */
  priority?: number;
}

/** 백엔드 레코드를 견적엔진 {@link Correction} 으로 정규화. */
export function toCorrection(raw: RawCorrection): Correction {
  return {
    id: String(raw.id),
    featureKey: raw.featureKey,
    correctedUnitPrice: Number(raw.correctedUnitPrice),
    explanation: raw.explanation,
    author: raw.author,
    priority: raw.priority,
    date: raw.createdAt,
  };
}

function authHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 서버에 저장된 모든 공유 보정을 로드해 견적엔진 {@link Correction} 배열로 반환.
 * 캐시 없음 — 항상 최신을 가져온다(저장 후 재요청 시 다른 직원의 보정까지 즉시 반영).
 */
export async function loadCorrections(
  token?: string | null,
): Promise<Correction[]> {
  const res = await fetch(`${BASE_URL}${CORRECTIONS_URL}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`공유 보정을 불러오지 못했습니다 (${res.status}).`);
  }
  const body = (await res.json()) as RawCorrection[] | null;
  return Array.isArray(body) ? body.map(toCorrection) : [];
}

/**
 * 새 공유 보정을 저장하고 서버가 영속화한 레코드를 {@link Correction} 으로 반환.
 * 본문에 author 를 절대 싣지 않는다 — 서버가 JWT principal 로 채운다.
 */
export async function postCorrection(
  token: string | null | undefined,
  body: NewCorrection,
): Promise<Correction> {
  const res = await fetch(`${BASE_URL}${CORRECTIONS_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      featureKey: body.featureKey,
      correctedUnitPrice: body.correctedUnitPrice,
      explanation: body.explanation,
      ...(body.priority != null ? { priority: body.priority } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`보정을 저장하지 못했습니다 (${res.status}).`);
  }
  return toCorrection((await res.json()) as RawCorrection);
}
