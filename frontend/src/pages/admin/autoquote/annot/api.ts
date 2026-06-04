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

/** 글자읽기(OCR) 응답 — 박스 영역에서 읽은 간판 글자. 글자수는 프론트 charCount 로 센다. */
export interface ReadTextResult {
  text: string;
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
    try {
      code = (await res.json())?.error || '';
    } catch {
      /* 본문 없음 */
    }
    throw new Error(`글자읽기 실패 (${res.status}${code ? ' ' + code : ''})`);
  }
  const j = await res.json();
  return { text: typeof j?.text === 'string' ? j.text : '' };
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
