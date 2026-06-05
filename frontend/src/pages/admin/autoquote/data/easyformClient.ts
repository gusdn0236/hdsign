/**
 * 자동견적 Slice 14 — 로컬 이지폼 자동기입 에이전트 클라이언트 (선택적 · feature-detected).
 *
 * PC 에 떠 있는 작업뷰어 에이전트(127.0.0.1:17345)를 **탐지**하고, 명세서 grid 를 이지폼 셀로
 * **매핑해 전송(스테이징)** 한다. 실제 기입은 사용자가 이지폼 '매출 거래명세서' 새로작성 창에서
 * 핫키(F6)를 눌렀을 때 에이전트가 수행한다 — 클릭이 정확한 창에 떨어지도록 실행 순간 이지폼이
 * 최상위여야 하기 때문(웹 버튼 직후엔 브라우저가 최상위).
 *
 * IRON LAW (anti-scenario 7): 프론트엔드는 **셀 입력만** 요청한다. Enter/저장(F5)/전자전송(F11)
 * 등 커밋을 요청하는 어떤 토큰도 본문에 담지 않으며, 사람이 이지폼에서 직접 확정한다. 에이전트가
 * 쓰는 Win32 입력도 셀 클릭 + '2' 한 글자(삽입 위치) + Ctrl+V 뿐이다.
 *
 * 에이전트 부재 PC 에서는 호출부가 probe 실패로 기능을 숨긴다(HIDDEN, not disabled).
 * 선례: OrderAdmin.jsx / FieldViewer.jsx 의 AGENT_URL + AbortController(~1.5s) + cache:'no-store'.
 */

/**
 * 이지폼 자동기입은 **사무 워처(hdsign-watcher)** 가 호스트한다(포트 5577 — OrderAdmin 의 /ping 과 동일).
 * 현장 에이전트(17345)가 아니라 워처에 통합 — 사무실은 상시 켜두는 워처 1개만으로 동작(별도 exe 없음).
 */
const AGENT_URL =
  import.meta.env.VITE_HDSIGN_WATCHER_URL || 'http://127.0.0.1:5577';

/**
 * 이지폼 한 행으로 채워질 셀들 — 정확히 이 7개(월일=자동·비고=미사용은 제외).
 * 모두 문자열(이지폼 셀에 붙여넣을 표시값). 숫자칸의 콤마 제거는 에이전트가 한다.
 */
export interface EasyformRow {
  item_code: string;
  item: string;
  spec: string;
  qty: string;
  unit_price: string;
  supply: string;
  tax: string;
}

/** AutoQuote 의 buildGrid() 한 행(한글 키) 모양 — 매핑 입력. */
export interface GridRow {
  품목코드?: string;
  품목?: string;
  규격?: string;
  수량?: string;
  단가?: string;
  공급가액?: string;
  세액?: string;
  [k: string]: string | undefined;
}

/** 이지폼 행에 허용되는 데이터 필드 — 정확히 이 7개뿐. 이 밖의 키는 '지시'로 보고 거부한다. */
const ALLOWED_ROW_KEYS: ReadonlyArray<keyof EasyformRow> = [
  'item_code',
  'item',
  'spec',
  'qty',
  'unit_price',
  'supply',
  'tax',
];

/**
 * IRON LAW 가드(구조적): 전송 본문은 정확히 `{ rows: EasyformRow[] }` 여야 한다.
 * 자유텍스트 '값'은 검사하지 않고(간판 텍스트에 enter/save 가 우연히 들어갈 수 있으므로),
 * '구조'만 본다 — 최상위 rows 외 키가 있거나, 행에 허용 7필드 밖의 키가 있으면 거부.
 */
export function assertNoCommitDirective(payload: { rows: EasyformRow[] }): void {
  const topKeys = Object.keys(payload).filter((k) => k !== 'rows');
  if (topKeys.length > 0) {
    throw new Error(
      `IRON LAW 위반: 본문에 허용되지 않은 최상위 지시 필드(${topKeys.join(', ')})가 있습니다.`,
    );
  }
  if (!Array.isArray(payload.rows)) {
    throw new Error('IRON LAW 위반: rows 는 배열이어야 합니다.');
  }
  const allowed = new Set<string>(ALLOWED_ROW_KEYS as readonly string[]);
  for (const row of payload.rows) {
    const extra = Object.keys(row).filter((k) => !allowed.has(k));
    if (extra.length > 0) {
      throw new Error(
        `IRON LAW 위반: 행에 허용되지 않은 지시 필드(${extra.join(', ')})가 있습니다.`,
      );
    }
  }
}

/**
 * buildGrid() 결과(한글 키 9칸) → 이지폼 행(영문 키 7칸) 매핑.
 * 7칸 모두 빈 행은 떨군다(삽입 클릭 수 = 데이터 행 수가 되도록).
 */
export function gridToEasyformRows(grid: GridRow[]): EasyformRow[] {
  return grid
    .map((g) => ({
      item_code: g['품목코드'] ?? '',
      item: g['품목'] ?? '',
      spec: g['규격'] ?? '',
      qty: g['수량'] ?? '',
      unit_price: g['단가'] ?? '',
      supply: g['공급가액'] ?? '',
      tax: g['세액'] ?? '',
    }))
    .filter((r) => ALLOWED_ROW_KEYS.some((k) => String(r[k]).trim() !== ''));
}

/** 에이전트 probe 응답. */
export interface EasyformProbe {
  ok: boolean;
  easyform: boolean;   // 이 PC 가 Win32 자동기입 가능한가
  hotkey: string;      // 실행 핫키 라벨(예: 'F6')
}

/**
 * 로컬 에이전트 탐지: `${AGENT_URL}/easyform/probe` 를 ~1.5s 타임아웃 + no-store 로 찔러본다.
 * 실패/중단/부재 → null → 호출부가 기능을 숨긴다.
 */
export async function probeEasyformAgent(): Promise<EasyformProbe | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${AGENT_URL}/easyform/probe`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<EasyformProbe>;
    return { ok: !!j.ok, easyform: !!j.easyform, hotkey: j.hotkey || 'F6' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 에이전트 스테이징 응답. */
export interface EasyformStaged {
  staged: boolean;
  count?: number;
  hotkey?: string;
  message?: string;
}

/**
 * 셀 채우기 요청(STAGE-ONLY): { rows } 만 POST 한다. 저장/Enter/확정 지시는 절대 넣지 않는다.
 * 전송 직전 IRON LAW 가드를 통과해야 하며, 위반 시 네트워크 호출 없이 throw 한다.
 * 응답은 즉시 돌아오고(실제 기입은 사용자가 이지폼 창에서 핫키로), staged/hotkey/count 를 담는다.
 */
export async function fillEasyform(rows: EasyformRow[]): Promise<EasyformStaged> {
  const payload = { rows };
  assertNoCommitDirective(payload); // 위반 시 fetch 없이 throw
  const res = await fetch(`${AGENT_URL}/easyform/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`이지폼 전송 실패 (${res.status}).`);
  }
  return (await res.json()) as EasyformStaged;
}
