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
  import.meta.env?.VITE_HDSIGN_WATCHER_URL || 'http://127.0.0.1:5577';

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
  /** 비고 — 첫 줄에 홈페이지 주문번호(예: '261103-19, 261103-20'). 동기화 때 이 번호로 주문을 찾는다. */
  remark: string;
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
  'remark',
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
/**
 * 이지폼 칸 길이 제한(바이트, 한글 2·영숫자 1 — 이지폼은 CP949). 넘치면 이지폼이 'n byte 이내로 입력' 창을 띄우고
 * 자동입력이 먹통이 됐음(사용자 2026-11-26) → 홈페이지 입력칸에서 미리 잘라 둔다.
 */
export const EF_BYTE_LIMITS: Record<string, number> = { 품목코드: 20, 품목: 50, 규격: 50, 수량: 20, 단가: 20, 공급가액: 20 };
export function efBytes(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) < 0x80 ? 1 : 2;
  return n;
}
/** key 칸 제한을 넘으면 앞에서부터 들어가는 만큼만 남긴다. 제한 없는 칸은 그대로. */
export function efClip(key: string, s: string): string {
  const lim = EF_BYTE_LIMITS[key];
  if (!lim || efBytes(s) <= lim) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const w = ch.charCodeAt(0) < 0x80 ? 1 : 2;
    if (n + w > lim) break;
    out += ch;
    n += w;
  }
  return out;
}

export function gridToEasyformRows(grid: GridRow[]): EasyformRow[] {
  return grid
    .map((g) => ({
      item_code: efClip('품목코드', g['품목코드'] ?? ''),
      item: efClip('품목', g['품목'] ?? ''),
      spec: efClip('규격', g['규격'] ?? ''),
      qty: efClip('수량', g['수량'] ?? ''),
      unit_price: efClip('단가', g['단가'] ?? ''),
      supply: efClip('공급가액', g['공급가액'] ?? ''),
      tax: g['세액'] ?? '',
      remark: g['비고'] ?? '',
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

// ---- 이지폼 → 홈페이지 가져오기 -------------------------------------------------
// 웹 [이지폼에서 가져오기] → POST /easyform/pull 로 대기(arm) → 워처가 코너에 '이지폼에서 가져오기 ▶'
// 버튼을 띄움 → 사용자가 이지폼 상세명세서를 열고 그 버튼 → 워처가 우클릭 '복사'로 5칸을 읽음
// → 웹이 GET /easyform/pull?id= 로 폴링해 rows 를 받는다. (읽기 전용 — 이지폼에 입력·저장 안 함)

/** 가져온 한 줄 — 품목코드·품목·규격·수량·단가 5칸만(월일·공급가액·세액·비고는 홈페이지에 칸이 없음). */
export interface EasyformPulledRow {
  item_code: string;
  item: string;
  spec: string;
  qty: string;
  unit_price: string;
  /** 비고 — 홈페이지 주문번호를 찾는 데만 쓴다. */
  remark?: string;
}

/** 글자에서 홈페이지 주문번호(YYMMDD-N) 뽑기 — '주문-261103-19' 도 '261103-19' 로. 순서 유지·중복 제거. */
export function extractOrderNos(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || '').matchAll(/(?<!\d)(\d{6}-\d{1,4})(?!\d)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 주문번호 앞의 '주문-'/'견적-' 떼기. */
export function orderNoCore(orderNumber: string | null | undefined): string {
  return (orderNumber || '').replace(/^(주문|견적)-/, '');
}

/** [이지폼에서 찾기] 로 목록에서 하나씩 열어 읽은 명세서 1건. */
export interface EasyformScannedStatement {
  idx: number; // 목록 맨 위에서 몇 번째(0부터) — 고른 1건을 다시 열 때 씀
  date: string; // 발행일 'YYYY.MM.DD'
  total: string; // 합계금액(화면 글자)
  rows?: EasyformPulledRow[]; // 전체 읽기(match)일 때만
  orderNos: string[]; // 비고에서 찾은 홈페이지 주문번호
  match?: boolean; // 주문번호로 찾았거나 고른 1건(전체 읽음)
  light?: boolean; // 훑기만 한 것 — 품목·규격·비고만
  items?: string[];
  specs?: string[];
  remarks?: string[];
  codes?: string[]; // 키워드 훑기 때만 — 품목코드·수량·단가(홈페이지 명세서 칸 그대로 보여주기용)
  qtys?: string[];
  prices?: string[];
}

export interface EasyformPullStatus {
  state: 'idle' | 'waiting' | 'running' | 'done' | 'error' | 'gone';
  message?: string;
  mode?: 'one' | 'scan';
  progress?: string; // scan 진행 '3/23 · 2026.10.12'
  rows?: EasyformPulledRow[];
  statements?: EasyformScannedStatement[];
  date?: string; // 직접가져오기: 명세서 발행일
  total?: string; // 직접가져오기: 합계금액
}

/** 가져오기 대기. scan = 이지폼 목록(매출처별 조회)에서 위부터 열어 찾기 — stopBefore 보다 오래되면 멈춤. */
export async function startEasyformPull(
  opts?: {
    mode: 'scan';
    stopBefore?: string;
    findOrderNo?: string;
    max?: number;
    clientName?: string; // 워처 코너 창 안내 문구('…'를 검색해주세요)
    clues?: boolean; // 단서 찾기 2차 — 비고 대신 품목·규격·비고를 훑기만(주문번호 안 찾음)
    keywords?: string[]; // 키워드로 찾기 — 워처가 훑는 동안 맞은 명세서를 오른쪽 위 판에 하나씩 띄움
    // 단서로 고른 1건만 열기 — 맨 위에서 openIdx 번째, 발행일·합계가 같아야 읽음. auto=코너 버튼 없이 바로.
    openIdx?: number;
    expectDate?: string;
    expectTotal?: string;
    auto?: boolean;
  },
): Promise<{ armed: boolean; id?: number; message?: string }> {
  const res = await fetch(`${AGENT_URL}/easyform/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
    cache: 'no-store',
    body: JSON.stringify(opts || {}),
  });
  if (!res.ok) throw new Error(`이지폼 가져오기 요청 실패 (${res.status}).`);
  return (await res.json()) as { armed: boolean; id?: number; message?: string };
}

export async function pollEasyformPull(id: number): Promise<EasyformPullStatus> {
  const res = await fetch(`${AGENT_URL}/easyform/pull?id=${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`이지폼 가져오기 상태 확인 실패 (${res.status}).`);
  return (await res.json()) as EasyformPullStatus;
}

export async function cancelEasyformPull(id: number): Promise<void> {
  try {
    await fetch(`${AGENT_URL}/easyform/pull/cancel?id=${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
      cache: 'no-store',
      body: '{}',
    });
  } catch {
    /* 워처가 꺼졌으면 무시 */
  }
}

// ---- 이지폼 일괄 가져오기(명세서 탭) ------------------------------------------------
// export: 떠 있는 이지폼(주식회사·개인) 각각에서 거래명세서 목록(올해)을 엑셀(csv)로 뽑아 목록으로.
// read  : 웹이 짝지은 명세서만 목록에서 열어 품목 표를 읽기. 읽기 전용 — 이지폼엔 아무것도 안 씀.

/** 이지폼 목록 CSV 한 줄 = 명세서 1건(품목은 첫 줄만). */
export interface EfListRow {
  biz: 'corp' | 'personal';
  bizName: string;
  idx: number; // 목록(기간으로 조회·역순) 맨 위에서 몇 번째 — 열 때 씀
  bizNo: string;
  client: string;
  date: string; // 발행일자 YYYY.MM.DD
  firstItem: string;
  total: string; // 합계(숫자)
  written: string; // 작성일자 YYYY.MM.DD
}

/** 이지폼 명세서 비고에 주문번호 적기(워처가 그 명세서를 열어 그 칸만 적고 저장). row 없으면 첫 빈 비고 칸. */
export interface EfStampItem {
  key: string;
  biz: string;
  idx: number;
  date: string;
  total: string;
  client?: string;
  nos: string[];
  row?: number;
  item?: string; // 그 줄 품목(읽었을 때) — 워처가 같은 줄인지 확인
  remark?: string; // 그 줄 기존 비고(읽었을 때)
  rowCount?: number; // 명세서 줄 수 — 워처가 비고 칸만 훑어 이미 적혔는지 확인
  force?: boolean; // 사람이 범위를 다시 정함 — 다른 줄에 번호가 있어도 이 줄에 적는다(이 줄에 이미 있으면 건너뜀)
  clear?: { row: number; item: string; remark: string }[]; // 같은 번호가 있던 다른 줄 — 거기선 지운다(옮겨 적기)
}

/** 홈페이지 → 이지폼 기존 명세서 반영 — 무엇이 바뀌는지(워처가 이지폼 표와 홈페이지 표를 비교). row = 이지폼 줄 번호(0부터). */
export interface EfPushPlan {
  same: boolean;
  mods: { row: number; from: EasyformPulledRow; to: EasyformPulledRow; cols: string[] }[];
  dels: { row: number; from: EasyformPulledRow }[];
  ins: { to: EasyformPulledRow }[];
  lostNos: string[]; // 지워지는 줄에 있던 주문번호(남는 줄엔 없음) — 있으면 반영 안 함
}

/** 반영할 이지폼 줄(홈페이지 표 → 6칸). */
export type EfPushRow = Pick<EasyformRow, 'item_code' | 'item' | 'spec' | 'qty' | 'unit_price' | 'remark'>;

export interface EfBulkResult {
  key: string;
  ok: boolean;
  skipped?: boolean; // 비고 적기 — 이미 적혀 있어서 안 건드림
  date?: string;
  total?: string;
  rows?: EasyformPulledRow[];
  message?: string;
  // push_read / push_apply
  biz?: 'corp' | 'personal';
  idx?: number;
  client?: string;
  nos?: string[];
  plan?: EfPushPlan;
  same?: boolean;
  cancelled?: boolean; // push_confirm — '이 명세서가 맞나요?'에 아니오 / manual_fill — 취소
  found?: boolean; // open_quick — 찾아서 띄웠나(못 찾으면 false, 에러 아님)
  bizNo?: string; // manual_fill — 저장한 명세서의 거래처 사업자번호
}

export interface EfBulkStatus {
  state: 'running' | 'done' | 'error' | 'idle' | 'gone';
  phase?:
    | 'export'
    | 'read'
    | 'stamp'
    | 'push_read'
    | 'push_apply'
    | 'new_fill'
    | 'open_show'
    | 'push_confirm'
    | 'open_quick'
    | 'manual_fill';
  message?: string;
  progress?: string;
  lists?: { biz: 'corp' | 'personal'; name: string; rows: EfListRow[] }[];
  results?: EfBulkResult[];
  paused?: boolean;
}

export async function startEfBulk(
  body:
    | { phase: 'export'; year?: number }
    | { phase: 'read'; items: (EfListRow & { key: string })[]; keepOrder?: boolean }
    | { phase: 'stamp'; items: EfStampItem[] }
    // 홈페이지 수정 → 이지폼 기존 명세서: 지문(date+total)이 있으면 그날 하루치, 없으면 from~to+client 를 비고 주문번호로 확인
    | {
        phase: 'push_read';
        nos: string[];
        target: EfPushRow[];
        date?: string;
        total?: string;
        from?: string;
        to?: string;
        client?: string;
        biz?: string; // 먼저 볼 이지폼(지난번에 끊은 쪽)
        clients?: string[]; // 이지폼에서 끊는 다른 이름들(기억해 둔 것) — 이 거래처 명세서만 본다
        due?: string; // 납기 YYYY.MM.DD — 가까운 날부터
      }
    // 이지폼에서 열기: 같은 방법으로 찾아 비고 주문번호 확인 → 열어 둔 채 이지폼을 앞으로(저장 없음)
    | {
        phase: 'open_show';
        nos: string[];
        date?: string;
        total?: string;
        from?: string;
        to?: string;
        client?: string;
        biz?: string;
        clients?: string[];
        due?: string;
      }
    // 새 명세서: 새로작성 → 사업자번호로 거래처 1건 선택(OCR 확인) → 입력 → 다시 읽어 같아야 저장
    | { phase: 'new_fill'; biz: string; bizNo: string; client: string; target: EfPushRow[]; due?: string }
    // [이지폼에서 열기] 연동 안 된 명세서 — 그 거래처·납기 앞뒤 days(기본 1)일만 빠르게, 못 찾으면 웹이 키워드 화면
    | { phase: 'open_quick'; nos: string[]; due: string; days?: number; client?: string; clients?: string[]; biz?: string }
    // [직접 고를게요] — 사람이 이지폼에서 새로작성·거래처 선택 → 워처 [작성 시작하기 ▶] → 입력·저장까지
    | { phase: 'manual_fill'; nos: string[]; target: EfPushRow[] }
    // [이지폼에 적용하기]: 찾아서 이지폼에 띄우고 워처 카드 '이 명세서가 맞나요?' → 네=적용·저장 / 아니오=취소(홈페이지로)
    | {
        phase: 'push_confirm';
        nos: string[];
        target: EfPushRow[];
        date?: string;
        total?: string;
        from?: string;
        to?: string;
        client?: string;
        biz?: string;
        clients?: string[];
        due?: string;
      }
    // 다시 열어 표가 expect(읽었을 때)와 같아야 고침 → 다시 읽어 target 과 같아야 저장
    | {
        phase: 'push_apply';
        biz: string;
        date: string;
        total: string;
        nos: string[];
        expect: EasyformPulledRow[];
        target: EfPushRow[];
      },
): Promise<{ started: boolean; id?: number; message?: string }> {
  const res = await fetch(`${AGENT_URL}/easyform/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`이지폼 작업 요청 실패 (${res.status}). 워처를 최신으로 다시 켜주세요.`);
  return res.json();
}

/** 이 PC 워처의 이지폼 작업 기록 끝부분(실패 원인 복사용). 워처가 옛 버전이거나 꺼져 있으면 null. */
export async function getEfLog(): Promise<{ text: string; pc?: string; path?: string } | null> {
  try {
    const res = await fetch(`${AGENT_URL}/easyform/log`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pollEfBulk(id: number): Promise<EfBulkStatus> {
  const res = await fetch(`${AGENT_URL}/easyform/bulk?id=${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`이지폼 작업 상태 확인 실패 (${res.status}).`);
  return res.json();
}

export async function cancelEfBulk(id: number): Promise<void> {
  try {
    await fetch(`${AGENT_URL}/easyform/bulk/cancel?id=${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
      cache: 'no-store',
      body: '{}',
    });
  } catch {
    /* 워처가 꺼졌으면 무시 */
  }
}

/** 일시정지(on=true)/계속(on=false) — 워처는 명세서를 다 닫고 다음 건으로 넘어가는 자리에서 멈춘다. */
export async function pauseEfBulk(id: number, on: boolean): Promise<void> {
  try {
    await fetch(`${AGENT_URL}/easyform/bulk/pause?id=${id}&on=${on ? 1 : 0}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HDSign-Field': '1' },
      cache: 'no-store',
      body: '{}',
    });
  } catch {
    /* 워처가 꺼졌으면 무시 */
  }
}

// ── 이지폼 저장 자동반영(워처 easyform_autosync) ─────────────────────────────────────
// 사무실 직원이 이지폼 '매출 거래명세서' [저장] → 워처가 "홈페이지에도 반영할까요?" → 예 → 명세서를 읽어 이벤트로 쌓음.
// 관리자 화면(EasyformAutoSync)이 폴링해서 카드로 확인받고 홈페이지 명세서를 덮어쓴다.
export interface EfAutoEvent {
  id: number;
  biz: string; // 'corp' | 'personal'
  bizName: string;
  client: string; // 거래처명(화면 글자 OCR — 한두 글자 틀릴 수 있음)
  date: string; // 발행일 'YYYY.MM.DD'
  total: string; // 합계금액(화면 글자)
  rows: EasyformPulledRow[];
  nos: string[]; // 비고에 이미 적힌 홈페이지 주문번호
  at: number;
}

export async function pollEfAuto(
  after: number,
): Promise<{ available: boolean; events: EfAutoEvent[]; reading?: boolean } | null> {
  try {
    const res = await fetch(`${AGENT_URL}/easyform/autosync?after=${after}`, { cache: 'no-store' });
    if (!res.ok) return null; // 옛 워처(이 기능 없음) = 404
    return await res.json();
  } catch {
    return null; // 워처 꺼짐 / 이 PC 엔 워처 없음
  }
}

async function efAutoPost<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${AGENT_URL}/easyform/autosync/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** 이 PC 의 홈페이지 탭이 여러 개여도 한 탭만 카드를 띄우게 — 먼저 가져간 탭이 true. */
export const claimEfAuto = (id: number, tab: string) =>
  efAutoPost<{ ok: boolean }>(`claim?id=${id}&tab=${encodeURIComponent(tab)}`).then((r) => !!r?.ok);

/** 이 탭이 브라우저에서 안 보여 앞으로 못 띄움 → 내려놓기. 워처가 관리자 페이지를 새 탭으로 열고, 새 탭이 가져간다. */
export const releaseEfAuto = (id: number, tab: string) =>
  efAutoPost<{ ok: boolean }>(`release?id=${id}&tab=${encodeURIComponent(tab)}`).then((r) => !!r?.ok);

/** 카드에서 다 끝남 → 이지폼 명세서 창을 다시 맨 앞으로. */
export const backEfAuto = (id: number) => efAutoPost<{ ok: boolean }>(`back?id=${id}`).then((r) => !!r?.ok);

/** 제목에 title 글자가 든 브라우저 창을 맨 앞으로(직원은 이지폼을 보고 있으니까). */
export const frontEfAuto = (title: string) => efAutoPost<{ ok: boolean }>('front', { title }).then((r) => !!r?.ok);

/** 아직 열려 있는 그 이지폼 명세서 비고에 주문번호를 적고 저장. row = 그 줄에(합친 명세서의 새 지시서 시작 줄), 없으면 첫 빈 비고.
 *  move = 지시서 1개짜리 — 번호를 '위에서부터 비고가 빈 첫 줄'로 옮겨 적기(맨 위에 줄 끼우면 밀리므로). rows = 비고 반영된 줄들. */
export const stampEfAuto = (id: number, nos: string[], row?: number, move = false, places?: { row: number; no: string }[]) =>
  efAutoPost<{ ok: boolean; message?: string; row?: number; remark?: string; skipped?: boolean; rows?: EasyformPulledRow[] }>(
    'stamp',
    // places = 합친 명세서에서 지시서마다 고른 시작 줄(그 줄 비고에 그 번호, 사용자 2026-11-25)
    { id, nos, row, move, places },
  ).then(
    (r) => r || { ok: false, message: '워처가 응답하지 않아요' },
  );
