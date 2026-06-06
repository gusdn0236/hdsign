/**
 * 자동견적 주석입력 — 백엔드 API 클라이언트(전부 admin JWT). 기밀(예측/근거 명세서·사진)은
 * 절대 번들하지 않고 런타임에 JWT 로 fetch 한다.
 *
 *  - predict   : POST /api/admin/autoquote/predict (slice-11) — 거래처+품목 → 예측 단가/근거
 *  - evidence  : GET  /api/admin/autoquote/evidence/{idx}?file= (slice-11) — 과거 명세서 grid + 사진
 *  - order     : GET  /api/admin/orders/{id} (slice-13 단건) — 지시서 이미지·거래처 컨텍스트
 *  - estimate  : GET/PUT /api/admin/orders/{id}/estimate (slice-12) — 명세서 저장/조회
 *  - easyform  : POST /api/admin/orders/{id}/estimate/easyform-uploaded (slice-12)
 */
export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

function authHeaders(token?: string | null, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export interface PredictItem {
  text: string;
  material?: string;
  size?: string;
  qty?: string;
}

export interface Prediction {
  item: string;
  size: string;
  qty: string;
  price: number;
  ref_invoice_idx: number | string;
  ref_file: string;
  src: string; // '이력' | '전체'
  score: number;
  reason: string;
}

/** 가격 예측 — 단일/다중 품목. 미프로비저닝(503)이면 null. */
export async function predict(
  token: string | null | undefined,
  client: string,
  items: PredictItem[],
): Promise<Prediction[] | null> {
  const res = await fetch(`${BASE_URL}/api/admin/autoquote/predict`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ client, items }),
  });
  if (res.status === 503) return null; // corpus 미프로비저닝
  if (!res.ok) throw new Error(`predict 실패 (${res.status})`);
  return res.json();
}

/**
 * 단가 찾아보기 — 한 품목의 품목코드 기준 과거 단가 후보들을 ①같은거래처 ②타거래처 ③관련 순으로.
 * predict 와 달리 한 품목에 대해 여러 후보(리스트)를 돌려준다. 미프로비저닝(503)이면 null.
 */
export async function lookupPrices(
  token: string | null | undefined,
  client: string,
  item: PredictItem,
  limit = 8,
): Promise<Prediction[] | null> {
  const res = await fetch(`${BASE_URL}/api/admin/autoquote/predict/lookup`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ client, item, limit }),
  });
  if (res.status === 503) return null; // corpus 미프로비저닝
  if (!res.ok) throw new Error(`단가 찾아보기 실패 (${res.status})`);
  return res.json();
}

/**
 * 다중 품목코드 단가 찾아보기 — codes 각각을 lookupPrices 로 조회해 합치고,
 * ① 사이즈 근접도(score, 정확일치=1.0) ② 같은 거래처(이력>타거래처>관련) 순으로 정렬.
 * 같은 물건이 여러 코드 표기로 흩어진 경우(예: 갈바레이저타공 + 갈바레이저전후광) 함께 검색.
 * codes 가 비면 fallbackText(품목명 등)로 1회 조회. 전부 미프로비저닝(503)이면 null.
 */
export async function lookupPricesMerged(
  token: string | null | undefined,
  client: string,
  codes: string[],
  spec: string,
  qty: string,
  opts?: { fallbackText?: string; limit?: number },
): Promise<Prediction[] | null> {
  const limit = opts?.limit ?? 50;
  const targets = codes.length
    ? codes.map((c) => ({ text: c, material: c }))
    : [{ text: opts?.fallbackText ?? '', material: '' }];
  const lists = await Promise.all(
    targets.map((t) => lookupPrices(token, client, { text: t.text, material: t.material, size: spec, qty }, limit)),
  );
  if (lists.every((l) => l == null)) return null; // 코퍼스 미프로비저닝
  const sp = (s: string) => (s === '이력' ? 0 : s === '타거래처' ? 1 : 2);
  const seen = new Set<string>();
  return lists
    .filter((l): l is Prediction[] => l != null)
    .flat()
    .filter((p) => {
      const k = `${p.ref_file}|${p.ref_invoice_idx}|${p.price}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.score - a.score || sp(a.src) - sp(b.src))
    .slice(0, limit);
}

export interface CodeSuggestion {
  code: string;
  count: number;
}

/**
 * 유사 품목코드 추천 — 입력 코드와 비슷한 코퍼스 코드들(같은 자재 다른 표기·오타)을 건수순으로.
 * 단가찾아보기 '비슷한 코드' 칩에 사용. 실패/없음이면 빈 배열.
 */
export async function similarCodes(
  token: string | null | undefined,
  code: string,
  limit = 8,
): Promise<CodeSuggestion[]> {
  if (!code.trim()) return [];
  const res = await fetch(
    `${BASE_URL}/api/admin/autoquote/predict/similar-codes?code=${encodeURIComponent(code)}&limit=${limit}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) return [];
  return res.json();
}

export interface EvidenceGridRow {
  item_code?: string;
  item?: string;
  spec?: string;
  qty?: string | number;
  unit_price?: string | number;
  [k: string]: unknown;
}
export interface Evidence {
  invoice_idx: number | string;
  photo_available: boolean;
  photo_content_type?: string;
  photo_base64?: string;
  /** many-to-many: 한 명세서의 여러 지시서 사진(메인 + 보조). 첫 장 = photo_base64. */
  photos?: { content_type: string; base64: string }[];
  grid: EvidenceGridRow[];
}

/** 근거 명세서 grid + 대표 사진. file 은 easyform_*.json 화이트리스트. 없으면 null(404). */
export async function evidence(
  token: string | null | undefined,
  invoiceIdx: number | string,
  file: string,
): Promise<Evidence | null> {
  const res = await fetch(
    `${BASE_URL}/api/admin/autoquote/evidence/${encodeURIComponent(String(invoiceIdx))}?file=${encodeURIComponent(file)}`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`evidence 실패 (${res.status})`);
  return res.json();
}

/** 글자읽기 일일 한도 현황. */
export interface VisionQuota {
  used: number;
  remaining: number;
  limit: number;
}

/** 글자읽기(OCR) 응답 — 박스 영역에서 읽은 간판 글자 + (있으면) 갱신된 일일 한도 현황. */
export interface ReadTextResult {
  text: string;
  quota?: VisionQuota;
}

/** daily_limit(일일 한도 소진) 에러 식별용 — 호출부가 전용 안내를 띄운다. */
export class DailyLimitError extends Error {
  quota?: VisionQuota;
  constructor(quota?: VisionQuota) {
    super('daily_limit');
    this.name = 'DailyLimitError';
    this.quota = quota;
  }
}

/** 글자읽기 일일 한도 현황 조회(버튼 옆 '오늘 남은 횟수' 표시·사전 차단용). 실패 시 null. */
export async function getVisionQuota(
  token: string | null | undefined,
): Promise<VisionQuota | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/admin/autoquote/vision/quota`, {
      headers: authHeaders(token),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { used: +j.used, remaining: +j.remaining, limit: +j.limit };
  } catch {
    return null;
  }
}

/**
 * 글자읽기 — 사진에서 박스로 오려낸 영역(base64 또는 data URI)을 보내 간판 글자만 읽어온다.
 * 기존 /vision 엔드포인트를 hints.mode='read_text' 로 재사용(서버가 저렴한 Haiku 로 분기).
 * 실패 시 throw — 호출부가 상태코드로 안내 메시지를 띄운다.
 */
export async function readText(
  token: string | null | undefined,
  imageBase64: string,
  mediaType = 'image/jpeg',
): Promise<ReadTextResult> {
  const res = await fetch(`${BASE_URL}/api/admin/autoquote/vision`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ imageBase64, mediaType, hints: { mode: 'read_text' } }),
  });
  if (!res.ok) {
    let code = '';
    let body: Record<string, unknown> | null = null;
    try {
      body = await res.json();
      code = String(body?.error || '');
    } catch {
      /* 본문 없음 */
    }
    if (res.status === 429 && code === 'daily_limit') {
      throw new DailyLimitError(
        body
          ? { used: +(body.used as number), remaining: 0, limit: +(body.limit as number) }
          : undefined,
      );
    }
    throw new Error(`글자읽기 실패 (${res.status}${code ? ' ' + code : ''})`);
  }
  const j = await res.json();
  const quota = j?.quota
    ? { used: +j.quota.used, remaining: +j.quota.remaining, limit: +j.quota.limit }
    : undefined;
  return { text: typeof j?.text === 'string' ? j.text : '', quota };
}

export interface OrderContext {
  id: number;
  orderNumber: string;
  clientCompanyName: string | null;
  title: string | null;
  worksheetPdfUrl: string | null;
  worksheetThumbnailUrl: string | null;
  hasEstimate?: boolean;
  easyformUploadedAt?: string | null;
}

/** 주문 단건 — 지시서 이미지/거래처 컨텍스트. */
export async function getOrder(token: string | null | undefined, id: number | string): Promise<OrderContext | null> {
  const res = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(String(id))}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`주문 조회 실패 (${res.status})`);
  return res.json();
}

export interface EstimateDoc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  estimate: any;
  savedAt: string | null;
  easyformUploadedAt: string | null;
  hasEstimate: boolean;
}

/** 저장된 명세서 조회 — 없으면 null(404). */
export async function getEstimate(token: string | null | undefined, orderId: number | string): Promise<EstimateDoc | null> {
  const res = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(String(orderId))}/estimate`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`명세서 조회 실패 (${res.status})`);
  return res.json();
}

/** 명세서 저장(upsert). doc = {grid:[...], ...}. */
export async function putEstimate(
  token: string | null | undefined,
  orderId: number | string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
): Promise<EstimateDoc> {
  const res = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(String(orderId))}/estimate`, {
    method: 'PUT',
    headers: authHeaders(token, true),
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`명세서 저장 실패 (${res.status})`);
  return res.json();
}

export async function markEasyformUploaded(
  token: string | null | undefined,
  orderId: number | string,
): Promise<EstimateDoc> {
  const res = await fetch(
    `${BASE_URL}/api/admin/orders/${encodeURIComponent(String(orderId))}/estimate/easyform-uploaded`,
    { method: 'POST', headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`이지폼 표시 실패 (${res.status})`);
  return res.json();
}
