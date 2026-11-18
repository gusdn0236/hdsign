/**
 * 이지폼 일괄 가져오기 — 홈페이지 지시서(명세서 비어 있는 주문) ↔ 이지폼 목록(CSV) 짝짓기.
 *
 * 이지폼 목록 한 줄엔 거래처명·발행일·작성일·첫 줄 품목·합계만 있다(품목 표·비고는 열어야 보임).
 * 그래서 여기서 먼저 **후보 순위**만 정하고, 1등 후보만 워처가 열어 읽는다.
 *
 * 점수 = 거래처(가장 큼) + 날짜 가까움 + 현장명(지시서 제목 ↔ 첫 줄 품목).
 *   - 날짜는 '같아야 함'이 아니라 가까울수록 점수(지시서 11/17 납 ↔ 명세서 11/18 도 거의 감점 없음).
 *     발행일·작성일 중 지시서 날짜(납기·등록일)에 더 가까운 쪽을 쓴다.
 *   - 첫 줄 품목이 '아크릴5T' 처럼 흔한 말이면 여러 명세서에 다 나와서 무게가 0 에 가깝다(IDF).
 * 배정: 점수 높은 짝부터 — 명세서 1건은 주문 1건에만.
 */
import type { EfListRow } from './easyformClient';

export interface EfOrder {
  id: number;
  orderNumber?: string | null;
  clientCompanyName?: string | null;
  title?: string | null;
  dueDate?: string | null;
  createdAt?: string | null;
}

export interface EfCandidate {
  row: EfListRow;
  key: string; // 'corp:12'
  score: number;
  client: number; // 0~1
  days: number; // 날짜 차이(일)
  title: number; // 0~1
}

export interface EfMatch {
  order: EfOrder;
  best: EfCandidate | null;
  others: EfCandidate[]; // 다음 후보들(사람이 바꿔볼 수 있게)
  sure: boolean; // 거래처 맞고 날짜 가깝고 2등과 차이 큼
}

export const efRowKey = (r: EfListRow) => `${r.biz}:${r.idx}`;

/** 거래처명 비교용 — (주)·주식회사·㈜·공백·기호 제거, 소문자. 괄호 안(지점명)은 따로 둔다. */
export function normClient(s: string | null | undefined): string {
  return (s || '')
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)/g, '')
    .replace(/[\s.,·\-_/'"]+/g, '')
    .toLowerCase();
}

function baseName(s: string): string {
  return normClient((s || '').replace(/\([^)]*\)/g, ''));
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hit = 0;
  for (const g of A) {
    const k = pool.indexOf(g);
    if (k >= 0) {
      hit++;
      pool.splice(k, 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

// 사람이 [맞아요] 로 확인한 '홈페이지 거래처 → 이지폼 거래처' 짝 — 이 PC 에 기억해 다음엔 1점.
const ALIAS_KEY = 'hd.efClientAlias';
function loadAlias(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
export function rememberClientAlias(web: string | null | undefined, ef: string): void {
  const w = normClient(web);
  const e = normClient(ef);
  if (!w || !e || w === e) return;
  try {
    const m = loadAlias();
    const list = m[w] || [];
    if (!list.includes(e)) m[w] = [e, ...list].slice(0, 5);
    localStorage.setItem(ALIAS_KEY, JSON.stringify(m));
  } catch {
    /* 저장 불가 무시 */
  }
}

/** 거래처 닮음 0~1. 같음 1, 한쪽이 다른 쪽을 포함 0.85(지점 괄호 차이 등), 아니면 글자쌍 유사도. */
export function clientSim(web: string | null | undefined, ef: string, alias = loadAlias()): number {
  const w = normClient(web);
  const e = normClient(ef);
  if (!w || !e) return 0;
  if (w === e || (alias[w] || []).includes(e)) return 1;
  const wb = baseName(web || '');
  const eb = baseName(ef);
  if (wb && wb === eb) return 0.92;
  if ((wb.length >= 2 && e.includes(wb)) || (eb.length >= 2 && w.includes(eb))) return 0.85;
  return Math.max(dice(w, e), dice(wb, eb));
}

const DAY = 86400000;
function toTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

/** 지시서 날짜(납기·등록일) ↔ 명세서 날짜(발행·작성) 중 가장 가까운 차이(일). 못 읽으면 999. */
export function dayGap(o: EfOrder, r: EfListRow): number {
  const os = [toTime(o.dueDate), toTime(o.createdAt)].filter((x): x is number => x != null);
  const rs = [toTime(r.date), toTime(r.written)].filter((x): x is number => x != null);
  let best = 999;
  for (const a of os) for (const b of rs) best = Math.min(best, Math.abs(a - b) / DAY);
  return Math.round(best);
}

/** 현장명 토큰 — 지시서 제목·첫 줄 품목에서 2글자 넘는 낱말(괄호 벗김). */
function tokens(s: string | null | undefined): string[] {
  return (s || '')
    .replace(/[()[\]{}<>]/g, ' ')
    .split(/[\s,/·+_\-:;]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

const MAX_DAYS = 45; // 이보다 멀면 후보에서 뺌
const MIN_CLIENT = 0.5;

export function matchOrders(
  orders: EfOrder[],
  rows: EfListRow[],
  used: { date: string; total: string; client: string }[],
): EfMatch[] {
  const alias = loadAlias();
  // 이미 다른 주문에 가져온 명세서(발행일·합계·거래처 같음)는 뺀다.
  const digits = (s: string) => String(s || '').replace(/[^0-9-]/g, '');
  const usedSet = used.map((u) => ({ k: `${u.date}|${digits(u.total)}`, client: u.client }));
  const free = rows.filter(
    (r) => !usedSet.some((u) => u.k === `${r.date}|${digits(r.total)}` && clientSim(u.client, r.client, alias) >= MIN_CLIENT),
  );
  // 첫 줄 품목 낱말의 흔함(IDF) — '아크릴5t' 처럼 여기저기 나오는 낱말은 무게 ≈ 0.
  const df = new Map<string, number>();
  const rowToks = free.map((r) => {
    const ts = [...new Set(tokens(r.firstItem))];
    ts.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
    return ts;
  });
  const N = free.length || 1;
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) / Math.log(N + 1);

  const perOrder = orders.map((o) => {
    const ot = tokens(o.title);
    const cands: EfCandidate[] = [];
    free.forEach((r, i) => {
      const c = clientSim(o.clientCompanyName, r.client, alias);
      const days = dayGap(o, r);
      if (days > MAX_DAYS) return;
      // 현장명: 지시서 제목 낱말이 첫 줄 품목에 들어 있나(또는 반대) — 드문 낱말일수록 큼.
      // 오타·띄어쓰기 차이('디앤에이부과' ↔ '디앤에이피부과')는 글자쌍 닮음으로 부분 점수.
      let tw = 0;
      for (const t of ot) {
        for (const x of rowToks[i]) {
          const sim = x.includes(t) || (x.length >= 3 && t.includes(x)) ? 1 : t.length >= 3 ? dice(t, x) : 0;
          if (sim >= 0.6) tw = Math.max(tw, idf(t) * sim);
        }
      }
      if (c < MIN_CLIENT && tw < 0.5) return;
      const dateScore = Math.exp(-days / 6); // 0일 1, 3일 0.6, 7일 0.3, 14일 0.1
      const score = 3 * c + 1.5 * dateScore + 1.5 * tw;
      cands.push({ row: r, key: efRowKey(r), score, client: c, days, title: tw });
    });
    cands.sort((a, b) => b.score - a.score || a.days - b.days);
    return { order: o, cands: cands.slice(0, 6) };
  });

  // 배정 — 모든 (주문, 명세서) 짝을 점수순으로, 명세서·주문 각각 한 번만.
  const pairs: { oi: number; c: EfCandidate }[] = [];
  perOrder.forEach((p, oi) => p.cands.forEach((c) => pairs.push({ oi, c })));
  pairs.sort((a, b) => b.c.score - a.c.score);
  const takenRow = new Set<string>();
  const bestOf = new Map<number, EfCandidate>();
  for (const { oi, c } of pairs) {
    if (bestOf.has(oi) || takenRow.has(c.key)) continue;
    bestOf.set(oi, c);
    takenRow.add(c.key);
  }
  return perOrder.map((p, oi) => {
    const best = bestOf.get(oi) || null;
    const others = p.cands.filter((c) => c.key !== best?.key).slice(0, 4);
    const second = others[0];
    const sure = !!best && best.client >= 0.85 && best.days <= 7 && (!second || best.score - second.score >= 0.8);
    return { order: p.order, best, others, sure };
  });
}

// ---- 가져온 줄 → 홈페이지 명세서 grid (AutoQuote 의 normEfRows + efRowsToGrid 와 같은 규칙) ----
const numOf = (s: string) => {
  const v = Number(String(s || '').replace(/[^0-9.-]/g, ''));
  return String(s || '').replace(/[^0-9]/g, '') && Number.isFinite(v) ? v : null;
};

export interface EfGridRow {
  월일: string;
  품목코드: string;
  품목: string;
  규격: string;
  수량: string;
  단가: string;
  공급가액: string;
  세액: string;
  비고: string;
  _qtyFixed: boolean;
}

export function efRowsToGrid(
  rows: { item_code?: string; item?: string; spec?: string; qty?: string; unit_price?: string; remark?: string }[],
): EfGridRow[] {
  return rows
    .map((r) => ({
      품목코드: r.item_code || '',
      품목: r.item || '',
      규격: r.spec || '',
      수량: r.qty || '',
      단가: r.unit_price || '',
      비고: r.remark || '',
    }))
    // 이지폼은 빈 수량을 '0' 으로 보여준다 → 단가 없는 줄(제목줄)의 0 은 빈칸, 다 빈 줄(표 끝)은 버림.
    .map((r) => (!r.단가 && /^0+$/.test(r.수량.trim()) ? { ...r, 수량: '' } : r))
    .filter((r) => Object.values(r).some((v) => (v || '').trim()))
    .map((r) => {
      const dp = numOf(r.단가);
      const qty = numOf(r.수량) || 1;
      const supply = dp != null ? dp * qty : null;
      return {
        월일: '',
        ...r,
        공급가액: supply != null ? String(supply) : '',
        세액: supply != null ? String(Math.round(supply * 0.1)) : '',
        _qtyFixed: true,
      };
    });
}
