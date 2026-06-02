/**
 * 자동견적 corpus + priors 로더 (JWT 백엔드 lazy-fetch + 프로세스 캐시).
 *
 * 기밀 학습 데이터(과거 명세서 코퍼스 4.66MB · 학습 prior)는 절대 프론트 번들/공개
 * 정적 자산으로 내보내지 않는다. 탭 진입 시 admin JWT 로 보호된
 *   GET /api/admin/autoquote/corpus
 *   GET /api/admin/autoquote/priors
 * 를 한 번만 가져와 모듈 레벨에 캐시한다(탭 재진입 시 재요청 없음 — 브라우저도 ETag 로 캐시).
 *
 * 백엔드 응답 코퍼스는 `{ _meta, lines: [...] }` 형태이며, 각 라인을 견적엔진의
 * {@link CorpusItem} 으로 정규화한다(normName → name, index 부여, source 기본 'invoice').
 */
import type { CorpusItem, Priors } from '../engine';

export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const CORPUS_URL = '/api/admin/autoquote/corpus';
const PRIORS_URL = '/api/admin/autoquote/priors';

/** 백엔드 corpus.json 의 한 라인 (build-corpus 산출 스키마). */
interface RawCorpusLine {
  category: string;
  /** 정규화된 품목명. */
  normName?: string;
  name?: string;
  brand?: string;
  spec?: string;
  qty?: number;
  unitPrice: number;
  width?: number;
  height?: number;
  area?: number;
  client?: string;
  date?: string;
  source?: 'invoice' | 'price-table';
}

export interface AutoQuoteData {
  corpus: CorpusItem[];
  priors: Priors;
}

/** 프로세스 캐시 — 탭 재진입 시 재요청 방지. */
let cache: AutoQuoteData | null = null;
/** 동시 진입 시 중복 fetch 방지(in-flight 공유). */
let inflight: Promise<AutoQuoteData> | null = null;

/** 코퍼스 응답을 견적엔진 {@link CorpusItem} 배열로 정규화. */
export function toCorpusItems(raw: unknown): CorpusItem[] {
  const lines: RawCorpusLine[] = Array.isArray(raw)
    ? (raw as RawCorpusLine[])
    : ((raw as { lines?: RawCorpusLine[] } | null)?.lines ?? []);
  return lines.map((l, i) => ({
    index: i,
    category: l.category,
    name: l.name ?? l.normName ?? l.category,
    brand: l.brand,
    spec: l.spec,
    width: l.width,
    height: l.height,
    qty: l.qty,
    unitPrice: l.unitPrice,
    client: l.client,
    date: l.date,
    source: l.source ?? 'invoice',
  }));
}

async function fetchJson(path: string, token?: string | null): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`자동견적 데이터를 불러오지 못했습니다 (${path}: ${res.status}).`);
  }
  return res.json();
}

/**
 * corpus + priors 를 JWT 백엔드에서 lazy-fetch 하고 캐시한다. 캐시가 있으면 즉시 반환.
 * 두 엔드포인트를 병렬로 호출한다.
 */
export async function loadAutoQuoteData(token?: string | null): Promise<AutoQuoteData> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [corpusRaw, priorsRaw] = await Promise.all([
      fetchJson(CORPUS_URL, token),
      fetchJson(PRIORS_URL, token),
    ]);
    const data: AutoQuoteData = {
      corpus: toCorpusItems(corpusRaw),
      priors: (priorsRaw as Priors) ?? {},
    };
    cache = data;
    return data;
  })();
  try {
    return await inflight;
  } catch (e) {
    inflight = null; // 실패 시 캐시하지 않음 — 재시도 가능하게.
    throw e;
  } finally {
    inflight = null;
  }
}

/** 테스트 전용: 모듈 캐시 초기화. */
export function __resetAutoQuoteCache(): void {
  cache = null;
  inflight = null;
}
