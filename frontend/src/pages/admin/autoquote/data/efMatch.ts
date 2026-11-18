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
import type { EfListRow, EasyformPulledRow } from './easyformClient';
import { extractOrderNos, orderNoCore } from './easyformClient';

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
  // 읽은 뒤 내용으로 다시 매긴 점수(rescoreByContent) — 규격↔지시서 도형 일치, 비고 주문번호
  final?: number;
  dimHit?: number;
  dimN?: number;
  remark?: 'own' | 'other' | '';
  clueHit?: number; // 사람이 넣은 단서 중 맞은 수
  clueN?: number;
}

export interface EfMatch {
  order: EfOrder;
  best: EfCandidate | null;
  others: EfCandidate[]; // 다음 후보들(사람이 바꿔볼 수 있게)
  sure: boolean; // 거래처 맞고 날짜 가깝고 2등과 차이 큼
  // 합친 명세서 — 같은 이지폼 명세서를 같이 쓰는 다른 주문 id(같은 거래처 지시서 여러 장을 명세서 1장으로 끊은 경우)
  mergedWith?: number[];
}

/**
 * 합친 명세서 허용 — 같은 거래처 지시서 여러 장을 명세서 1장으로 끊는 경우가 있다(사용자 2026-11-18).
 * 1:1 배정 뒤 짝이 없는(또는 납기 근처에 없는) 지시서는, 다른 지시서가 가져간 명세서라도
 * 같은 거래처·납기 ±1일이면 같이 쓰게 한다. 그리고 같은 명세서를 쓰는 주문끼리 mergedWith 로 묶는다.
 */
function shareLeftovers<T extends { id: number; best: EfCandidate | null; cands: EfCandidate[] }>(list: T[]): void {
  for (const p of list) {
    if (p.best && p.best.days <= 3) continue;
    const taken = new Set(list.filter((x) => x !== p && x.best).map((x) => x.best!.key));
    const c = p.cands.find((x) => taken.has(x.key) && x.client >= 0.85 && x.days <= 1);
    if (c) p.best = c;
  }
}

export function markMerged(ms: EfMatch[]): EfMatch[] {
  const byKey = new Map<string, number[]>();
  ms.forEach((m) => m.best && byKey.set(m.best.key, [...(byKey.get(m.best.key) || []), m.order.id]));
  return ms.map((m) => {
    const ids = m.best ? (byKey.get(m.best.key) || []).filter((id) => id !== m.order.id) : [];
    return { ...m, mergedWith: ids.length ? ids : undefined, sure: ids.length ? false : m.sure };
  });
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

/**
 * 날짜 차이(일). 이지폼은 **발행일 = 납기**로 쓰는 게 보통(실측 정답 50건: 같은 날 37, ±3일 44) →
 * 납기가 있으면 '납기 ↔ 발행일'만 본다. 납기가 없을 때만 등록일 ↔ 발행·작성일 중 가까운 쪽. 못 읽으면 999.
 */
export function dayGap(o: EfOrder, r: EfListRow): number {
  const due = toTime(o.dueDate);
  const issued = toTime(r.date);
  if (due != null && issued != null) return Math.round(Math.abs(due - issued) / DAY);
  const os = [toTime(o.createdAt)].filter((x): x is number => x != null);
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
  cluesByOrder: Record<number, string[]> = {},
): EfMatch[] {
  const alias = loadAlias();
  // 이미 다른 주문에 가져온 명세서(발행일·합계·거래처 같음)는 뺀다.
  const digits = (s: string) => String(s || '').replace(/[^0-9-]/g, '');
  const usedSet = used.map((u) => ({ k: `${u.date}|${digits(u.total)}`, client: u.client }));
  const free = rows.filter(
    (r) => Number(digits(r.total)) > 0 && // 0원·마이너스(반품·정정) 명세서는 후보에서 뺌
      !usedSet.some((u) => u.k === `${r.date}|${digits(r.total)}` && clientSim(u.client, r.client, alias) >= MIN_CLIENT),
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
      const dateScore = Math.exp(-days / 2); // 0일 1, 1일 .61, 2일 .37, 3일 .22, 7일 .03 — 납기 당일이 확실히 앞
      // 사람이 넣은 단서가 목록의 첫 줄 품목에 있으면 미리 앞으로(전체 품목은 읽은 뒤 rescore 에서)
      const cl = cluesByOrder[o.id] || [];
      const pre = cl.length ? clueHits(cl, [{ item: r.firstItem }]).hit / cl.length : 0;
      const score = 3 * c + 2.5 * dateScore + 1.5 * tw + 2 * pre;
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
  // (읽기 전엔 날짜만으로 합친 명세서를 만들지 않는다 — 아직 안 쓴 명세서를 기존 것에 잘못 붙임. 읽은 뒤 근거로만)
  const work = perOrder.map((p, oi) => ({ id: oi, best: bestOf.get(oi) || null, cands: p.cands }));
  return markMerged(
    perOrder.map((p, oi) => {
      const best = work[oi].best;
      const others = p.cands.filter((c) => c.key !== best?.key).slice(0, 4);
      const second = others[0];
      const sure = !!best && best.client >= 0.85 && best.days <= 3 && (!second || best.score - second.score >= 0.8);
      return { order: p.order, best, others, sure };
    }),
  );
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
    .map((r) => (/^0+$/.test(r.단가.trim()) ? { ...r, 단가: '' } : r)) // 제목·메모 줄의 단가 '0' 은 빈칸
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


// ---- 읽은 뒤 내용으로 다시 매기기 (2026-11-18 실데이터 점검) -----------------------------------------
// 홈페이지 지시서엔 현장명이 없다(제목 거의 비어 있음, PDF 글자도 도형). 그래서 같은 거래처·같은 날 명세서가
// 여럿이면 거래처·날짜만으론 못 가린다(실측 1등 정답 70%). 대신 지시서 도형 크기(mm, 치수 오버레이 데이터)와
// 이지폼 규격 칸 숫자('2040*1470', 'h:350')를 맞춰 보면 틀린 7건 중 6건이 가려졌다 → 후보 몇 개를 같이 읽고 다시 매김.

/** 지시서 도형 데이터(/api/public/worksheets/{no}/objects) → 도형 가로·세로 mm 목록(10mm 이상). */
export function worksheetDims(g: { objects?: { w?: number; h?: number }[]; extent?: { w?: number; h?: number } } | null): number[] {
  if (!g) return [];
  const set = new Set<number>();
  for (const o of g.objects || []) {
    for (const v of [o.w, o.h]) if (v && v >= 10) set.add(Math.round(v));
  }
  for (const v of [g.extent?.w, g.extent?.h]) if (v && v >= 10) set.add(Math.round(v));
  return [...set];
}

/** 규격 칸 숫자(20 이상) — '2040*1470*100' → 2040,1470,100 / 'h:350' → 350. */
export function specNums(rows: EasyformPulledRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) for (const m of (r.spec || '').matchAll(/\d{2,5}/g)) if (+m[0] >= 20) out.push(+m[0]);
  return out;
}

/**
 * 같이 읽을 후보 — 1등 + **같은 거래처·납기 ±3일 안** 후보(최대 3개). 그 안에서 규격 치수·비고로 최종 순위.
 * 1등부터 납기와 3일 넘게 떨어져 있으면(납기 근처에 없음) 점수 비슷한 후보를 대신 본다.
 */
export function candidatesToRead(m: EfMatch, hasClues = false): EfCandidate[] {
  if (!m.best) return [];
  // 단서를 넣은 지시서 — 단서로 가려낼 수 있으니 같은 거래처 납기 ±5일까지 조금 넓게 최대 4개
  if (hasClues) return [m.best, ...m.others.filter((c) => c.client >= 0.85 && c.days <= 5).slice(0, 3)];
  const near = m.best.days <= 3
    ? m.others.filter((c) => c.client >= 0.85 && c.days <= 3)
    : m.others.filter((c) => c.client >= 0.85 && c.score >= m.best!.score - 1.5);
  return [m.best, ...near.slice(0, 2)];
}

/**
 * 읽은 후보들을 내용으로 다시 매겨 1:1 로 다시 짝짓는다.
 *   final = 처음 점수 + 4×(규격 일치율 - 0.5) + (비고에 이 주문번호 +10 / 다른 주문번호만 -4)
 *   규격 일치율 = (맞은 숫자 + 0.5) / (숫자 수 + 1) — 숫자가 없으면 0.5(중립).
 * 읽지 않은 후보는 처음 점수 그대로 '다른 후보'에 남는다.
 */
export function rescoreByContent(
  matches: Record<number, EfMatch>,
  reads: Record<string, { ok: boolean; rows?: EasyformPulledRow[] }>,
  dimsByOrder: Record<number, number[] | undefined>,
  cluesByOrder: Record<number, string[]> = {},
): Record<number, EfMatch> {
  const scored: Record<number, EfCandidate[]> = {};
  const pairs: { id: number; c: EfCandidate }[] = [];
  for (const [idStr, m] of Object.entries(matches)) {
    const id = Number(idStr);
    const own = orderNoCore(m.order.orderNumber);
    const dims = dimsByOrder[id] || [];
    const all = [m.best, ...m.others].filter((c): c is EfCandidate => !!c);
    scored[id] = all.map((c) => {
      const rd = reads[c.key];
      if (!rd?.ok) return { ...c, final: c.score };
      const rows = rd.rows || [];
      const nums = specNums(rows);
      const hit = dims.length ? nums.filter((n) => dims.some((d) => Math.abs(n - d) <= Math.max(5, n * 0.03))).length : 0;
      const dimRate = dims.length && nums.length ? (hit + 0.5) / (nums.length + 1) : 0.5;
      const nos = extractOrderNos(rows.map((r) => r.remark || '').join(' '));
      const remark: EfCandidate['remark'] = nos.includes(own) ? 'own' : nos.length ? 'other' : '';
      // 사람이 넣은 단서 — 다 맞으면 +7, 일부면 비율만큼, 하나도 없으면 -2
      const cl = cluesByOrder[id] || [];
      const ch = cl.length ? clueHits(cl, rows).hit : 0;
      const clueTerm = cl.length ? 5 * (ch / cl.length) + (ch === cl.length ? 2 : 0) - (ch === 0 ? 2 : 0) : 0;
      const final = c.score + 4 * (dimRate - 0.5) + clueTerm + (remark === 'own' ? 10 : remark === 'other' ? -4 : 0);
      return {
        ...c,
        final,
        dimHit: dims.length ? hit : undefined,
        dimN: dims.length ? nums.length : undefined,
        remark,
        clueHit: cl.length ? ch : undefined,
        clueN: cl.length ? cl.length : undefined,
      };
    });
    scored[id].forEach((c) => pairs.push({ id, c }));
  }
  pairs.sort((a, b) => (b.c.final ?? b.c.score) - (a.c.final ?? a.c.score));
  const taken = new Set<string>();
  const best = new Map<number, EfCandidate>();
  for (const { id, c } of pairs) {
    if (best.has(id) || taken.has(c.key)) continue;
    // 읽어 둔 후보가 있으면 안 읽은 후보로는 짝짓지 않는다(보여줄 표가 없음) — 읽은 것 우선
    if (!reads[c.key]?.ok && scored[id].some((x) => reads[x.key]?.ok && !taken.has(x.key))) continue;
    best.set(id, c);
    taken.add(c.key);
  }
  // 비고에 이 주문번호가 적힌 명세서는 다른 주문이 가져갔어도 이 주문 것(합친 명세서 — 비고에 번호 여러 개)
  for (const id of Object.keys(scored).map(Number)) {
    const own = scored[id].find((c) => c.remark === 'own');
    if (own && best.get(id)?.key !== own.key) best.set(id, own);
  }
  // 짝 없는 지시서 — 같은 거래처·납기 ±1일 명세서를 같이 쓰기. 근거(규격 치수 60%+·2개+ 일치)가 있을 때만.
  const work = Object.keys(scored).map(Number).map((id) => ({
    id,
    best: best.get(id) || null,
    cands: scored[id].filter((c) => reads[c.key]?.ok && (c.dimHit || 0) >= 2 && (c.dimHit || 0) / (c.dimN || 1) >= 0.6),
  }));
  shareLeftovers(work);
  work.forEach((w) => w.best && best.set(w.id, w.best));
  const out: Record<number, EfMatch> = {};
  for (const [idStr, m] of Object.entries(matches)) {
    const id = Number(idStr);
    const b = best.get(id) || null;
    const others = scored[id].filter((c) => c.key !== b?.key).sort((x, y) => (y.final ?? y.score) - (x.final ?? x.score));
    const second = others[0];
    const sure =
      !!b &&
      (b.remark === 'own' ||
        (!!b.clueN && b.clueHit === b.clueN && (!second || (second.clueHit || 0) < b.clueN)) ||
        (b.client >= 0.85 && b.days <= 7 && (!second || (b.final ?? b.score) - (second.final ?? second.score) >= 1.5)));
    out[id] = { ...m, best: b, others, sure };
  }
  for (const m of markMerged(Object.values(out))) out[m.order.id] = m;
  return out;
}


// ---- 사람이 넣은 단서(키워드·사이즈) -------------------------------------------------------------
/** 입력 글자 → 단서들. 띄어쓰기·쉼표·줄바꿈으로 나눔. 'H:350'·'2400*600' 같은 사이즈는 한 덩어리. */
export function splitClues(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || '').split(/[,\n\s]+/)) {
    const c = raw.trim();
    if (c && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

const normC = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase();

/**
 * 단서가 명세서 줄들에 몇 개 있나.
 *  - 사이즈('2400*600', 'h350', '1200') = 그 숫자들이 모두 규격 칸 숫자에 있음(±3%·±5mm)
 *  - 글자 = 품목코드·품목·규격·비고 칸에 들어 있음(또는 3글자 넘는 칸이 단서 안에 — clueMatch 와 같은 규칙)
 */
export function clueHits(
  clues: string[],
  rows: { item_code?: string; item?: string; spec?: string; remark?: string }[],
): { hit: number; n: number } {
  const cells = rows.flatMap((r) => [r.item_code, r.item, r.spec, r.remark]).map((x) => normC(x || '')).filter(Boolean);
  const specNumsAll = rows.flatMap((r) => [...(r.spec || '').matchAll(/\d{2,5}/g)].map((m) => +m[0]));
  let hit = 0;
  for (const raw of clues) {
    const c = normC(raw);
    if (!c) continue;
    const nums = [...c.matchAll(/\d{2,5}/g)].map((m) => +m[0]);
    const isSize = nums.length > 0 && /^[a-z:]*\d+([*x×]\d+)*(mm)?$/.test(c);
    if (isSize) {
      if (nums.every((n) => specNumsAll.some((d) => Math.abs(d - n) <= Math.max(5, n * 0.03)))) hit++;
    } else if (cells.some((x) => x.includes(c) || (x.length >= 3 && c.includes(x)))) {
      hit++;
    }
  }
  return { hit, n: clues.length };
}
