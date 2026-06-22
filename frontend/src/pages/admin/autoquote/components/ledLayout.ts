/**
 * LED 개수 계산 — 실제 모양(폴리곤) 안에 우리 조립규칙대로 LED 를 채워 개수를 센다.
 *
 * 조립규칙(사장님 확정, 2026-06-22):
 *  - 모듈형(3구/미들2구/미니3구/1구): 잔넬 안을 한 줄로 이어 왕복하며 채움. 모듈 사이 간격은 '선길이'를
 *    넘을 수 없다(=절대 상한). 줄 바꿈(U턴)은 구부림 길이를 빼야 해 줄간격 ≤ 선길이×BEND. 빈 공간이
 *    크게 남지 않도록 간격을 좁혀서라도 고르게.
 *  - 연속형(줄엘이디 2.5mm/PCB 1.7mm): 한 줄로 쭉, 단위마다 1개. 개수 ≈ 깐 길이 ÷ 단위.
 *
 * 채움 = 수평 스캔라인. 한 행(가로줄)에서 폴리곤과 만나는 구간(span)을 구해 그 안에 채운다. 여러 폴리곤을
 * 함께 넘기면 짝수-홀수 규칙으로 교차를 세므로, 글자 'O' 의 바깥+안쪽 링을 같이 선택하면 가운데 구멍이
 * 자동으로 빠진다. 좌표는 워처가 준 mm(DXF Y=위쪽) 그대로 — 화면 투영은 호출측(LedOverlay)이 한다.
 */

export const BEND = 0.9; // 줄 바꿈 구부림으로 까먹는 비율(추정) → 줄간격 최대 = 선길이 × BEND.

export type LedFamily = 'module' | 'linear';

export interface LedSpec {
  key: string;
  name: string;
  family: LedFamily;
  color: string;
  // module
  w?: number;
  h?: number;
  bulbs?: number;
  wire?: number; // 선길이(mm) = 모듈 사이 간격 절대 상한
  // linear
  unitMm?: number; // 단위 길이당 1개
  stripH?: number; // 실제 세로(mm, 시각용)
  rowPitch?: number; // 면 채울 때 줄 간격(mm, 가정값 — 실측 후 조정)
}

export const LED_SPECS: LedSpec[] = [
  { key: 'g3', name: '3구', family: 'module', color: '#e23b3b', w: 68, h: 15, bulbs: 3, wire: 80 },
  { key: 'm2', name: '미들2구', family: 'module', color: '#ee9b00', w: 43, h: 15, bulbs: 2, wire: 65 },
  { key: 'mini3', name: '미니3구', family: 'module', color: '#0a9396', w: 30, h: 10, bulbs: 3, wire: 40 },
  { key: 'g1', name: '1구', family: 'module', color: '#7b2cbf', w: 13, h: 10, bulbs: 1, wire: 25 },
  { key: 'strip', name: '줄엘이디', family: 'linear', color: '#1f9d57', unitMm: 2.5, stripH: 0.6, rowPitch: 25 },
  { key: 'pcb', name: 'PCB', family: 'linear', color: '#2b6cb0', unitMm: 1.7, stripH: 0.7, rowPitch: 25 },
];

export interface FillResult {
  count: number;
  spec: LedSpec;
  // 객체(한 글자) 안의 연속 트레일들. 보통 1개(시작 고무캡~끝). 모듈 중심(mm), 진행 순서대로.
  // 모듈 방향은 트레일 진행 방향(이웃)으로 렌더러가 그린다.
  chains: { cx: number; cy: number }[][];
  rows: { cy: number; segs: [number, number][] }[]; // 연속형 행별 채워진 구간(mm)
  note?: string;
}

/** 점이 폴리곤들(짝수-홀수=구멍 반영) 안에 있나. 오른쪽 반직선 교차수로 판정. */
function pointInPolys(polys: number[][][], x: number, y: number): boolean {
  let inside = false;
  for (const poly of polys) {
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i][1];
      const yj = poly[j][1];
      if (yi > y !== yj > y) {
        const xint = poly[i][0] + ((y - yi) / (yj - yi)) * (poly[j][0] - poly[i][0]);
        if (x < xint) inside = !inside;
      }
    }
  }
  return inside;
}

/** y 높이의 수평선이 폴리곤들과 만나는 구간 [x0,x1] 목록(짝수-홀수). */
function spansAt(polys: number[][][], y: number): [number, number][] {
  const xs: number[] = [];
  for (const poly of polys) {
    const n = poly.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const y1 = a[1];
      const y2 = b[1];
      // 반열림 구간 규칙으로 꼭짓점 중복 교차 방지.
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
  }
  xs.sort((p, q) => p - q);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

function bboxOf(polys: number[][][]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polys)
    for (const pt of p) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// 배선을 빼는 방향(끝/고무캡이 향하는 쪽). 키패드 789/4 6/123 의 8방향. mm(DXF Y=위쪽) 단위 벡터.
export type ExitDir = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';
const DIRV: Record<ExitDir, [number, number]> = {
  N: [0, 1],
  S: [0, -1],
  E: [1, 0],
  W: [-1, 0],
  NE: [1, 1],
  NW: [-1, 1],
  SE: [1, -1],
  SW: [-1, -1],
};

/**
 * 한 '객체(잔넬)' = 외곽 폴리곤(+그 안의 구멍 폴리곤들) 에 spec 의 LED 를 조립규칙대로 채운다.
 * 여러 객체를 한꺼번에 넣지 말 것 — 객체마다 시작(고무캡)·끝이 따로 있어야 하므로 호출측에서 객체별로 부른다.
 * exitDir = 배선(끝)을 빼는 방향. 끝이 그 방향, 시작(고무캡)은 반대쪽이 되도록 체인 순서를 정한다.
 */
const PATH_CAP = 800; // 한 글자 후보 모듈이 이보다 많으면 경로계산 생략(개수만, 성능)

export function fillLeds(polys: number[][][], spec: LedSpec, exitDir: ExitDir = 'S', centerHint?: { x: number; y: number }): FillResult {
  const bb = bboxOf(polys);
  if (!bb || bb.h <= 0) return { count: 0, spec, chains: [], rows: [] };

  if (spec.family === 'module') {
    const w = spec.w!;
    const wire = spec.wire!;
    const maxRow = wire * BEND;
    const maxLink = w + wire + 2;
    const v = DIRV[exitDir] || DIRV.S;
    const ccx = (bb.minX + bb.maxX) / 2;
    const towardX = centerHint ? Math.sign(centerHint.x - ccx) || 1 : 0;
    const endScore = (cx: number, cy: number) => cx * (v[0] + towardX * 0.35) + cy * v[1];

    // 긴 축을 따라 줄(세로로 길면 세로). 스캔 공간 = 가로 행.
    const vertical = bb.h > bb.w;
    const Pp = vertical ? polys.map((poly) => poly.map((pt) => [pt[1], pt[0]])) : polys;
    const b = bboxOf(Pp)!;
    const real = (sx: number, sy: number) => (vertical ? { cx: sy, cy: sx } : { cx: sx, cy: sy });

    // 1) 스캔라인 후보점 — 각 행의 '획 단면(span)' 안에 균등 배치(가는 획·빗살도 덮음). 폭 안 inset.
    const nrows = Math.max(1, Math.round(b.h / maxRow));
    const rowStep = b.h / nrows;
    const G: { sx: number; sy: number }[] = [];
    for (let r = 0; r < nrows; r++) {
      const cy = b.minY + rowStep * (r + 0.5);
      for (const [a, e] of spansAt(Pp, cy)) {
        const sw = e - a;
        if (sw < w * 0.55) {
          G.push({ sx: (a + e) / 2, sy: cy });
          continue;
        }
        let nx = Math.max(1, Math.round(sw / (w + wire * 0.35)));
        nx = Math.max(nx, Math.ceil(sw / (w + wire)));
        while (nx > 1 && sw / nx < w * 0.9) nx--;
        const inset = Math.min(w / 2, sw / 2 - 1);
        const lo = a + inset;
        const hi = e - inset;
        for (let c = 0; c < nx; c++) G.push({ sx: nx === 1 ? (a + e) / 2 : lo + ((hi - lo) * c) / (nx - 1), sy: cy });
      }
    }
    const N = G.length;
    if (N === 0) return { count: 0, spec, chains: [], rows: [] };
    if (N > PATH_CAP) return { count: N, spec, chains: [], rows: [], note: '개수만(많아서 배선 생략)' };
    if (N === 1) return { count: 1, spec, chains: [[real(G[0].sx, G[0].sy)]], rows: [] };

    // 2) 유효 링크(선길이 이내 + 잇는 선이 모양 안). 인접 그래프.
    const segInside = (i: number, j: number, ts: number[]) => {
      const a = G[i];
      const c = G[j];
      for (const t of ts) if (!pointInPolys(Pp, a.sx + (c.sx - a.sx) * t, a.sy + (c.sy - a.sy) * t)) return false;
      return true;
    };
    const adj: number[][] = G.map(() => []);
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++)
        if (Math.hypot(G[j].sx - G[i].sx, G[j].sy - G[i].sy) <= maxLink && segInside(i, j, [0.15, 0.3, 0.5, 0.7, 0.85])) {
          adj[i].push(j);
          adj[j].push(i);
        }
    const escore = (i: number) => {
      const rp = real(G[i].sx, G[i].sy);
      return rp.cx * (v[0] + towardX * 0.35) + rp.cy * v[1];
    };
    let start = 0;
    for (let i = 1; i < N; i++) if (escore(i) < escore(start)) start = i;
    // 분기 정렬키 — 가까운 것 우선(곡선·모양을 짧게 따라감) + 직진 + 막다른 이웃(Warnsdorff).
    // 가중치는 실데이터(주문-260622-05) + 합성도형/폰트글리프/동물실루엣 수백종 스윕으로 최적화.
    const okey = (cur: number, j: number, pdx: number, pdy: number, mark: boolean[]) => {
      let deg = 0;
      for (const k of adj[j]) if (!mark[k]) deg++;
      const dx = G[j].sx - G[cur].sx;
      const dy = G[j].sy - G[cur].sy;
      const dist = Math.hypot(dx, dy) || 1;
      const bend = pdx || pdy ? 1 - (pdx * dx + pdy * dy) / ((Math.hypot(pdx, pdy) || 1) * dist) : 0;
      return 1.5 * (dist / maxLink) + 0.6 * bend + 0.5 * deg;
    };

    // 3) 백트래킹 DFS 최장 단일경로(직진 우선). 큰 글자는 비용상 그리디 1패스로 폴백.
    const visited = new Array(N).fill(false);
    let bestOrder: number[] = [start];
    let steps = 0;
    const CAP = 120000;
    const dfs = (cur: number, path: number[], pdx: number, pdy: number): boolean => {
      if (path.length > bestOrder.length) bestOrder = path.slice();
      if (path.length === N) return true;
      if (++steps > CAP) return false;
      const nbrs = adj[cur].filter((j) => !visited[j]).sort((j1, j2) => okey(cur, j1, pdx, pdy, visited) - okey(cur, j2, pdx, pdy, visited));
      for (const j of nbrs) {
        visited[j] = true;
        path.push(j);
        if (dfs(j, path, G[j].sx - G[cur].sx, G[j].sy - G[cur].sy)) return true;
        path.pop();
        visited[j] = false;
      }
      return false;
    };
    visited[start] = true;
    if (N <= 240) {
      dfs(start, [start], 0, 0);
    } else {
      const path = [start];
      let cur = start;
      let pdx = 0;
      let pdy = 0;
      for (;;) {
        let best = -1;
        let bestK = Infinity;
        for (const j of adj[cur]) {
          if (visited[j]) continue;
          const k = okey(cur, j, pdx, pdy, visited);
          if (k < bestK) {
            bestK = k;
            best = j;
          }
        }
        if (best < 0) break;
        pdx = G[best].sx - G[cur].sx;
        pdy = G[best].sy - G[cur].sy;
        visited[best] = true;
        cur = best;
        path.push(cur);
      }
      bestOrder = path;
    }

    // 4) 남은 점을 '모양 안으로만 지나는' 연결(분기 되돌림 리드)로 같은 체인에 이어붙임 → 캡/혓바닥 1개.
    let order = bestOrder.slice();
    const seen = new Array(N).fill(false);
    for (const i of order) seen[i] = true;
    const insideLink = (i: number, j: number, capmul: number) => Math.hypot(G[j].sx - G[i].sx, G[j].sy - G[i].sy) <= maxLink * capmul && segInside(i, j, [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]);
    const greedyExtend = (s: number): number[] => {
      const sub = [s];
      seen[s] = true;
      let cur = s;
      let pdx = 0;
      let pdy = 0;
      for (;;) {
        let best = -1;
        let bestK = Infinity;
        for (const j of adj[cur]) {
          if (seen[j]) continue;
          const k = okey(cur, j, pdx, pdy, seen);
          if (k < bestK) {
            bestK = k;
            best = j;
          }
        }
        if (best < 0) break;
        pdx = G[best].sx - G[cur].sx;
        pdy = G[best].sy - G[cur].sy;
        cur = best;
        seen[cur] = true;
        sub.push(cur);
      }
      return sub;
    };
    let guard = 0;
    while (order.length < N && guard < N + 5) {
      guard++;
      let end = order[order.length - 1];
      let cands: number[] = [];
      for (let j = 0; j < N; j++) if (!seen[j] && insideLink(end, j, 3)) cands.push(j);
      if (!cands.length) {
        const s0 = order[0];
        const c2: number[] = [];
        for (let j = 0; j < N; j++) if (!seen[j] && insideLink(s0, j, 3)) c2.push(j);
        if (c2.length) {
          order = order.reverse();
          end = order[order.length - 1];
          cands = c2;
        }
      }
      if (!cands.length) for (let j = 0; j < N; j++) if (!seen[j] && insideLink(end, j, 6)) cands.push(j);
      if (!cands.length) break;
      let nb = cands[0];
      let nd = Infinity;
      for (const j of cands) {
        const d = Math.hypot(G[end].sx - G[j].sx, G[end].sy - G[j].sy);
        if (d < nd) {
          nd = d;
          nb = j;
        }
      }
      order = order.concat(greedyExtend(nb));
    }

    // 5) 끝이 배선쪽이 되게(소프트). 단일 체인 반환(방향은 렌더러가 트레일로).
    let chain = order.map((i) => real(G[i].sx, G[i].sy));
    if (endScore(chain[chain.length - 1].cx, chain[chain.length - 1].cy) < endScore(chain[0].cx, chain[0].cy)) chain = chain.reverse();
    return { count: chain.length, spec, chains: [chain], rows: [] };
  }

  // 연속형(줄엘이디/PCB)
  const unit = spec.unitMm!;
  const rowPitch0 = spec.rowPitch!;
  let ny = Math.max(1, Math.ceil(bb.h / rowPitch0));
  const rowPitch = bb.h / ny;
  const rows: { cy: number; segs: [number, number][] }[] = [];
  let count = 0;
  for (let r = 0; r < ny; r++) {
    const cy = bb.minY + rowPitch * (r + 0.5);
    const segs = spansAt(polys, cy);
    let len = 0;
    for (const [a, b2] of segs) len += b2 - a;
    count += Math.round(len / unit); // 절반 넘게 남으면 1개 더(반올림)
    if (segs.length) rows.push({ cy, segs });
  }
  return { count, spec, chains: [], rows, note: '줄간격은 가정값(실측 후 조정)' };
}
