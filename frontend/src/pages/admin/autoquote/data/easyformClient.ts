/**
 * 자동견적 Slice 4 — 로컬 easyform 자동기입 에이전트 클라이언트 (선택적 · feature-detected).
 *
 * 이 모듈은 PC 에 설치된 로컬 에이전트(127.0.0.1:17345)를 **탐지**하고, 승인된 견적 라인을
 * easyform 의 셀로 **매핑**해 전송한다. 그 이상은 하지 않는다.
 *
 * IRON LAW (anti-scenario 7): 프론트엔드는 **셀 입력만** 요청한다. Enter/저장/확정 등
 * 커밋을 요청하는 어떤 토큰도 본문에 담지 않으며, 사람이 easyform 에서 직접 확정한다.
 * Win32 키시퀀스(절대 VK_RETURN/save 안 보냄; ALLOWED_VKS={Ctrl,V})는 로컬 에이전트가
 * 이미 구현·검증한 영역이다 — 여기서는 재구현하지 않고, 셀 데이터만 넘긴다.
 *
 * 에이전트 부재 PC 에서는 호출부가 probe 실패로 기능 자체를 숨긴다(HIDDEN, not disabled).
 * 선례: OrderAdmin.jsx / FieldViewer.jsx 의 AGENT_URL + AbortController(~1.5s) + cache:'no-store'.
 */

/** 로컬 에이전트 주소 — 기존 어드민 선례와 동일한 env 키/기본값. */
const AGENT_URL =
  import.meta.env.VITE_HDSIGN_AGENT_URL || 'http://127.0.0.1:17345';

/** easyform 한 행으로 채워질 셀들(품목코드·품목·규격·수량·단가). */
export interface EasyformRow {
  item_code: string;
  item: string;
  spec: string;
  qty: number;
  unit_price: number;
}

/** 매핑 입력 — 컴포넌트의 PricedLine 과 구조적으로 호환되는 최소 모양. */
export interface PricedLineLike {
  entry: {
    category: string;
    w?: string;
    h?: string;
    coats?: string;
    qty?: string;
    brandText?: string;
  };
  result: { unitPrice: number };
}

/**
 * IRON LAW 가드: 전송 본문 어디에도 Enter/Save/확정/commit 류 토큰이 있으면 거부한다.
 * 셀 데이터에 이런 토큰이 섞일 일은 없지만, 어떤 경로로든 커밋 지시가 본문에 새어들면
 * 전송 자체를 막는 최후의 방어선이다(anti-scenario 7).
 */
const FORBIDDEN_TOKEN = /VK_RETURN|ENTER|RETURN|SAVE|저장|commit/i;

/** 규격 문자열: `${w}x${h}` + (유효 도수 1~7 시 `· N도`) + (브랜드텍스트 식별용). */
function buildSpec(e: PricedLineLike['entry']): string {
  const parts: string[] = [];
  if (e.w && e.h) parts.push(`${e.w}x${e.h}`);
  else if (e.w) parts.push(String(e.w));
  else if (e.h) parts.push(String(e.h));
  const coats = Number(e.coats);
  if (Number.isFinite(coats) && coats >= 1 && coats <= 7) {
    parts.push(`${coats}도`);
  }
  const brand = (e.brandText ?? '').trim();
  if (brand) parts.push(brand);
  return parts.join(' · ');
}

/**
 * 승인된 견적 라인 → easyform 행 매핑. 순수 함수(네트워크 없음).
 * item_code 는 추적용 라인 코드(AQ-1, AQ-2 …) — easyform 의 품목 마스터 코드가 아니라
 * 직원이 어떤 견적 라인에서 왔는지 식별하는 용도다. 단가는 라인 단가(unitPrice)를 쓴다.
 */
export function buildEasyformRows(lines: PricedLineLike[]): EasyformRow[] {
  return lines.map((line, i) => ({
    item_code: `AQ-${i + 1}`,
    item: line.entry.category,
    spec: buildSpec(line.entry),
    qty: (() => {
      const q = Number(line.entry.qty);
      return Number.isFinite(q) && q > 0 ? q : 1;
    })(),
    unit_price: Math.round(line.result.unitPrice),
  }));
}

/**
 * 로컬 에이전트 탐지: `${AGENT_URL}/easyform/probe` 를 ~1.5s AbortController 타임아웃 +
 * cache:'no-store' 로 한 번 찔러본다. 실패/중단/부재 → false → 호출부가 기능을 숨긴다.
 */
export async function probeEasyformAgent(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${AGENT_URL}/easyform/probe`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 셀 채우기(FILL-ONLY): { rows } 만 POST 한다. 저장/Enter/확정/commit 지시는 절대 넣지 않는다.
 * 전송 직전 IRON LAW 가드를 통과해야 하며, 위반 시 네트워크 호출 없이 throw 한다.
 */
export async function fillEasyform(rows: EasyformRow[]): Promise<void> {
  const body = JSON.stringify({ rows });
  if (FORBIDDEN_TOKEN.test(body)) {
    throw new Error(
      'IRON LAW 위반: 전송 본문에 Enter/Save/확정/commit 토큰이 포함될 수 없습니다.',
    );
  }
  const res = await fetch(`${AGENT_URL}/easyform/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body,
  });
  if (!res.ok) {
    throw new Error(`easyform 셀 채우기 실패 (${res.status}).`);
  }
}
