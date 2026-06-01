/**
 * 자동견적 Slice 2 — 비전(작업지시서 인식) 클라이언트.
 *
 * 브라우저는 **절대** Anthropic 을 직접 호출하지 않는다. 이미지를 base64 로 읽어
 * hdsign Java 백엔드 프록시(POST /api/admin/autoquote/vision)에 admin JWT 로 보내고,
 * 서버가 forced tool-use 로 추출한 RICH 스키마(JSON)를 그대로 받는다. ANTHROPIC 키는
 * 서버 전용 — 이 파일 어디에서도 키를 읽거나 보관하거나 노출하지 않는다.
 */
import { BASE_URL } from '../data/corpusClient';

const VISION_URL = '/api/admin/autoquote/vision';

/** 작업지시서 한 항목의 치수(비전 추출). 모두 mm, 도수는 N도(칠 횟수). */
export interface VisionDimension {
  w?: number;
  h?: number;
  coats?: number;
}

/**
 * 백엔드 forced tool-use 가 반환하는 RICH 스키마.
 * (helpers.ts MOCK_VISION_ITEMS 와 동일한 모양 — 라우트 모킹과 1:1.)
 */
export interface VisionItems {
  client?: string;
  contact?: string;
  order_date?: string;
  due_date?: string;
  /** 항목별 간판 종류 — 라인 수의 기준(line i ↔ sign_types[i]). */
  sign_types?: string[];
  materials?: string[];
  /** 항목별 치수(sign_types 와 같은 인덱스). */
  dimensions?: VisionDimension[];
  /** 식별용 브랜드 텍스트 — 가격예측 아님(식별필터). */
  brand_text?: string;
  /** 항목별 수량(없으면 1). */
  qty?: number[];
  notes?: string;
}

/** 업로드/붙여넣기 이미지를 base64 + mediaType 으로 읽는다(키 없음, 순수 클라이언트 I/O). */
export function readImageFile(
  file: Blob,
): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // result = "data:<mediaType>;base64,<payload>"
      const comma = result.indexOf(',');
      const header = result.slice(0, comma);
      const base64 = result.slice(comma + 1);
      const mediaType =
        /data:([^;]+);base64/.exec(header)?.[1] || file.type || 'image/png';
      resolve({ base64, mediaType });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 이미지를 백엔드 비전 프록시로 보내고 RICH 스키마를 받는다.
 * 200 이 아니면 throw → 호출부가 수동입력 폴백으로 전환한다(자동 재시도 없음).
 */
export async function requestVision(
  imageBase64: string,
  mediaType: string,
  token?: string | null,
): Promise<VisionItems> {
  const res = await fetch(`${BASE_URL}${VISION_URL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ imageBase64, mediaType }),
  });
  if (!res.ok) {
    throw new Error(`비전 추출 실패 (${res.status}).`);
  }
  return (await res.json()) as VisionItems;
}
