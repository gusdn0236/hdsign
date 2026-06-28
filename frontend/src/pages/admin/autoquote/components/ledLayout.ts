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

// 채움 = '중심선 스캔 + 단일 체인 + 깔끔배치'(사장님 확정, 2026-06-28. 미들2구 고덕농협 199 + 3구 Cell Fusion 118 실측).
//  · 후보: 주 스캔(긴축에 '수직'으로 획을 가로지름) + 직교 스캔 중 놓친 얇은 획만 패치. 얇음~중간=1줄(획 1자), 두꺼움=2줄+.
//  · 간격 ≈ 선길이(wire) — '사잇선 최대로 벌린' 자연 간격(실측: 미들2구 68≈65, 3구 77≈80). 자동개수 pitch=wire.
//    targetCount 주면 그 개수에 맞게 pitch 이분탐색(글자별 개수 직접지정 가능).
//  · 사잇선 = 거리 제약만(중심거리 ≤ wire+w). 회전·교차·폴리곤 밖 통과 무관 — 사장님.
//  · 단일 체인: 글씨당 시작(고무캡)·끝(혓바닥) 딱 1개. 분기(Y·T)는 솔버가 분기점 두 번 지나 덮고, 못 잇는 자리는 브릿지 모듈로 끊김 0.
//  · 깔끔배치: 모듈 방향 = 국소 획 방향(PCA) — 임의 회전 금지. 테두리 밖 금지 → 각도·이동 시도해 안으로(딱 닿는 건 OK). 끝 혓바닥은 무조건 밖.
const SOLVE_MAX_N = 130; // 후보가 이보다 많으면 백트래킹 생략(그리디 1패스, 성능).

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
  // linear(연속형) — count = 면적/areaPerLed + 둘레/perimPerLed (실측 피팅)
  unitMm?: number; // 스트립상 LED 간격(mm, 시각용 점 간격)
  stripH?: number; // 실제 세로(mm, 시각용)
  rowPitch?: number; // 면 채울 때 줄 간격(mm, 시각용)
  areaPerLed?: number; // 면적당 LED 1개(mm²) — 내부 채움 항
  perimPerLed?: number; // 둘레당 LED 1개(mm) — 가장자리 항(좁은 획 보정)
}

export const LED_SPECS: LedSpec[] = [
  { key: 'g3', name: '3구', family: 'module', color: '#e23b3b', w: 68, h: 15, bulbs: 3, wire: 80 },
  { key: 'm2', name: '미들2구', family: 'module', color: '#ee9b00', w: 43, h: 15, bulbs: 2, wire: 65 },
  { key: 'mini3', name: '미니3구', family: 'module', color: '#0a9396', w: 30, h: 10, bulbs: 3, wire: 40 },
  { key: 'g1', name: '1구', family: 'module', color: '#7b2cbf', w: 13, h: 10, bulbs: 1, wire: 25 },
  // 연속형: count = 면적/areaPerLed + 둘레/perimPerLed. 줄엘이디는 GUNP+ASPESI 10글자 실측 피팅(글자별 ±3, 총 709/707).
  { key: 'strip', name: '줄엘이디', family: 'linear', color: '#1f9d57', unitMm: 16.67, stripH: 8, rowPitch: 25.8, areaPerLed: 1037, perimPerLed: 22.0 },
  { key: 'pcb', name: 'PCB', family: 'linear', color: '#2b6cb0', unitMm: 16.67, stripH: 8, rowPitch: 25.8, areaPerLed: 1037, perimPerLed: 22.0 }, // ⚠️실측 전 가정(줄엘이디와 동일)
];

export interface FillResult {
  count: number;
  spec: LedSpec;
  // 객체(한 글자) 안의 연속 트레일들. 보통 1개(시작 고무캡~끝). 모듈 중심(mm), 진행 순서대로.
  // deg = 모듈 방향(국소 획 방향, 도) — 있으면 렌더러가 이 각도로 그린다(없으면 트레일 방향).
  chains: { cx: number; cy: number; deg?: number }[][];
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

// 한 글자(외곽+구멍)의 면적(mm²)·둘레(mm) — 개수 모델·학습 POST 가 쓰는 표준 측정값.
// 면적 = 200줄 스캔 적분(spansAt 은 even-odd 라 구멍 자동 제외). 둘레 = 모든 폴리(바깥+구멍) 변 길이 합.
// fillLeds(모듈/연속형 둘 다)와 Ctrl+F8 실측 입력이 동일 함수를 써 같은 값으로 학습/예측되게 한다.
export function runMetrics(polys: number[][][]): { area: number; perim: number } {
  const bb = bboxOf(polys);
  if (!bb || bb.h <= 0) return { area: 0, perim: 0 };
  const nn = 200, st = bb.h / nn;
  let area = 0;
  for (let k = 0; k < nn; k++) {
    const cy = bb.minY + bb.h * ((k + 0.5) / nn);
    for (const [a, e] of spansAt(polys, cy)) area += (e - a) * st;
  }
  let perim = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return { area, perim };
}

// 한 종류의 '기본' 개수계수(학습 전/소표본 prior). 모듈=면적÷(w×wire×0.93)·둘레항 없음, 연속형=스펙값.
// fillLeds 와 LedOverlay 의 학습 블렌드가 같은 기본값을 쓰도록 단일 정의(중복 방지).
export function defaultCoeff(spec: LedSpec): { areaPerLed: number; perimPerLed: number } {
  if (spec.family === 'module') return { areaPerLed: (spec.w ?? 1) * (spec.wire ?? 1) * 0.93, perimPerLed: Infinity };
  return { areaPerLed: spec.areaPerLed ?? 1037, perimPerLed: spec.perimPerLed ?? 22 };
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

export function fillLeds(polys: number[][][], spec: LedSpec, centerHint?: { x: number; y: number }, targetCount?: number): FillResult {
  const bb = bboxOf(polys);
  if (!bb || bb.h <= 0) return { count: 0, spec, chains: [], rows: [] };

  if (spec.family === 'module') {
    const w = spec.w!;
    const wire = spec.wire!;
    const maxLink = wire + w; // 사잇선 예산(중심거리 상한). 이보다 멀면 끊김.
    const v = DIRV.S; // 모듈 배치 순서용 기준축(시각상 위→아래). 배선/방향 개념은 제거됨.
    const ccx = (bb.minX + bb.maxX) / 2;
    const towardX = centerHint ? Math.sign(centerHint.x - ccx) || 1 : 0;

    const vertical = bb.h > bb.w;
    const real = (sx: number, sy: number) => ({ cx: sx, cy: sy }); // G 는 이미 실좌표(mm).
    const bh = spec.h ?? 10;

    // ── 1) 후보 G — 주 스캔(긴축에 '수직'으로 획 가로지름) + 직교 스캔 패치(놓친 얇은/나란한 획) → 모든 획 커버.
    //   각 후보에 단면 폭(sw) 저장 → 좁음=1자, 넓음=회전(최대 90°)으로 1줄 커버, 아주 넓음(>1.5w)=2줄.
    //   개수=면적÷(w×wire×0.93)(면적당 LED 종류무관 일정) 또는 targetCount, pitch 이분탐색. ──
    const scanLine = (transpose: boolean, pitch: number): { sx: number; sy: number; sw: number }[] => {
      const Q = transpose ? polys.map((poly) => poly.map((pt) => [pt[1], pt[0]])) : polys;
      const bq = bboxOf(Q)!;
      const nrows = Math.max(1, Math.round(bq.h / pitch));
      const rowStep = bq.h / nrows;
      const out: { sx: number; sy: number; sw: number }[] = [];
      for (let r = 0; r < nrows; r++) {
        const cy = bq.minY + rowStep * (r + 0.5);
        for (const [a, e] of spansAt(Q, cy)) {
          const sw = e - a;
          // 사장님 규칙: 폭 2배(2w) 미만 = 1열(방향은 폭으로 결정 — 1자/회전). 2w 이상 = 2줄+(전역격자 정렬).
          if (sw < w * 2) {
            out.push(transpose ? { sx: cy, sy: (a + e) / 2, sw } : { sx: (a + e) / 2, sy: cy, sw });
            continue;
          }
          const inset = Math.min(w / 2, sw / 2 - 1);
          const x0 = a + inset, x1 = e - inset;
          // 열(칸)을 '전역 격자'((m+0.5)×pitch)에 맞춰 배치 → 줄마다 칸이 안 어긋나 폭 일정 구간은 줄 수 일정.
          const xs: number[] = [];
          let m = Math.ceil(x0 / pitch - 0.5);
          for (;;) {
            const x = (m + 0.5) * pitch;
            if (x > x1) break;
            if (x >= x0) xs.push(x);
            m++;
          }
          if (xs.length === 0) xs.push((a + e) / 2);
          for (const x of xs) out.push(transpose ? { sx: cy, sy: x, sw: 0 } : { sx: x, sy: cy, sw: 0 });
        }
      }
      return out;
    };
    const candidates = (pitch: number): { sx: number; sy: number; sw: number }[] => {
      const Gm = scanLine(!vertical, pitch);
      const thr2 = (pitch * 0.85) ** 2;
      for (const p of scanLine(vertical, pitch)) {
        let far = true;
        for (const q of Gm) if ((p.sx - q.sx) ** 2 + (p.sy - q.sy) ** 2 <= thr2) { far = false; break; }
        if (far) Gm.push(p);
      }
      return Gm;
    };
    // 목표 개수 — 지정(targetCount) 또는 자동 = 면적/areaPerLed + 둘레/perimPerLed (연속형과 동일한 통합 모델).
    //   기본값 areaPerLed=w×wire×0.93, perimPerLed=∞(둘레항 0) → 종전 '면적÷(w×wire×0.93)'와 완전 동일(무회귀).
    //   학습(Ctrl+F8 실측→서버 피팅)으로 areaPerLed/perimPerLed 가 채워지면 그 종류만 자동 보정된다.
    //   (중심선 길이만으로 세면 '짧지만 넓은 획'(고의 ㄱ)이 과소 → 면적 기반이 글자별로 정확.)
    const dc = defaultCoeff(spec);
    const areaPerLed = spec.areaPerLed ?? dc.areaPerLed;
    const perimPerLed = spec.perimPerLed ?? dc.perimPerLed;
    let tgt = targetCount && targetCount > 0 ? targetCount : 0;
    if (!tgt) {
      const m = runMetrics(polys);
      tgt = Math.max(1, Math.round(m.area / areaPerLed + m.perim / perimPerLed));
    }
    // pitch 이분탐색 — 탐색 중 '목표 개수에 가장 가까운' 후보 집합을 기억해 채택(±1 오차 최소화, 줄 균일성 보존).
    let lo = w * 0.4, hi = w * 5;
    let G = candidates(hi);
    let bestErr = Math.abs(G.length - tgt);
    for (let it = 0; it < 26; it++) {
      const Pm = (lo + hi) / 2;
      const c = candidates(Pm);
      const err = Math.abs(c.length - tgt);
      if (err < bestErr || (err === bestErr && c.length <= tgt)) {
        bestErr = err;
        G = c;
      }
      if (c.length > tgt) lo = Pm;
      else hi = Pm;
    }
    const swMap = new Map<string, number>(); // 위치→단면폭(회전량 결정용)
    for (const g of G) swMap.set(Math.round(g.sx) + ',' + Math.round(g.sy), g.sw);
    const N = G.length;
    if (N === 0) return { count: 0, spec, chains: [], rows: [] };
    if (N > PATH_CAP) return { count: N, spec, chains: [], rows: [], note: '개수만(많아서 배선 생략)' };
    if (N === 1) return { count: 1, spec, chains: [[{ ...real(G[0].sx, G[0].sy), deg: 0 }]], rows: [] };

    const dist = (i: number, j: number) => Math.hypot(G[i].sx - G[j].sx, G[i].sy - G[j].sy);
    const es = (i: number) => {
      const rp = real(G[i].sx, G[i].sy);
      return rp.cx * (v[0] + towardX * 0.35) + rp.cy * v[1];
    };
    // ── 2) 인접 = 거리 ≤ 사잇선 예산(maxLink). segInside 없음 — 사잇선은 회전/교차/폴리곤 밖 통과 허용. ──
    const adj: number[][] = G.map(() => []);
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++)
        if (dist(i, j) <= maxLink) {
          adj[i].push(j);
          adj[j].push(i);
        }

    // ── 3) 강한 해밀턴 경로 솔버 — Warnsdorff(막다른 이웃 먼저)+직진우선 백트래킹. 분기점이 넓으면 경로가
    //   분기점을 두 번 지나 3번째 가지까지 한 줄로 덮는다(대부분 끊김 0 단일 체인). 여러 시작점 시도. ──
    let order: number[];
    const startCand = (() => {
      let s0 = 0;
      for (let i = 1; i < N; i++) if (es(i) < es(s0)) s0 = i;
      const byDeg = Array.from({ length: N }, (_, i) => i).sort((p, q) => adj[p].length - adj[q].length);
      const list = [s0];
      for (const i of byDeg) if (!list.includes(i)) list.push(i);
      return list;
    })();
    if (N <= SOLVE_MAX_N) {
      let steps = 0;
      const CAP = 250000;
      const solve = (startNode: number): { full: boolean; path: number[] } => {
        const vis = new Array(N).fill(false);
        vis[startNode] = true;
        steps = 0;
        let longest = [startNode];
        const dfs = (cur: number, path: number[], pdx: number, pdy: number): boolean => {
          if (path.length > longest.length) longest = path.slice();
          if (path.length === N) return true;
          if (++steps > CAP) return false;
          const nbrs = adj[cur]
            .filter((j) => !vis[j])
            .sort((j1, j2) => {
              let d1 = 0;
              for (const k of adj[j1]) if (!vis[k]) d1++;
              let d2 = 0;
              for (const k of adj[j2]) if (!vis[k]) d2++;
              if (d1 !== d2) return d1 - d2; // Warnsdorff: 막다른(저차수) 먼저
              const a1x = G[j1].sx - G[cur].sx, a1y = G[j1].sy - G[cur].sy;
              const a2x = G[j2].sx - G[cur].sx, a2y = G[j2].sy - G[cur].sy;
              const b1 = pdx || pdy ? 1 - (pdx * a1x + pdy * a1y) / ((Math.hypot(pdx, pdy) || 1) * (Math.hypot(a1x, a1y) || 1)) : 0;
              const b2 = pdx || pdy ? 1 - (pdx * a2x + pdy * a2y) / ((Math.hypot(pdx, pdy) || 1) * (Math.hypot(a2x, a2y) || 1)) : 0;
              return b1 - b2; // 동률이면 직진(굽힘 작게)
            });
          for (const j of nbrs) {
            vis[j] = true;
            path.push(j);
            if (dfs(j, path, G[j].sx - G[cur].sx, G[j].sy - G[cur].sy)) return true;
            path.pop();
            vis[j] = false;
          }
          return false;
        };
        const full = dfs(startNode, [startNode], 0, 0);
        return { full, path: longest };
      };
      let bestPath = [startCand[0]];
      let tries = 0;
      for (const s of startCand) {
        const { full, path } = solve(s);
        if (path.length > bestPath.length) bestPath = path;
        if (full) {
          bestPath = path;
          break;
        }
        if (++tries >= 6) break;
      }
      order = bestPath;
    } else {
      // 큰 글자: 그리디 1패스(백트래킹 생략).
      const vis = new Array(N).fill(false);
      let cur = startCand[0];
      vis[cur] = true;
      order = [cur];
      for (;;) {
        let best = -1;
        let bk = Infinity;
        for (const j of adj[cur]) {
          if (vis[j]) continue;
          let deg = 0;
          for (const k of adj[j]) if (!vis[k]) deg++;
          const k = deg * 1000 + dist(cur, j);
          if (k < bk) {
            bk = k;
            best = j;
          }
        }
        if (best < 0) break;
        vis[best] = true;
        order.push(best);
        cur = best;
      }
    }

    // ── 4) 남은 점(해밀턴 불가 글자 = ㈈류)을 가장 가까운 '끝'에 붙여 단일 체인 유지(점프 최소화). ──
    const used = new Array(N).fill(false);
    for (const i of order) used[i] = true;
    while (order.length < N) {
      const rest: number[] = [];
      for (let j = 0; j < N; j++) if (!used[j]) rest.push(j);
      let end = order[order.length - 1];
      const s0 = order[0];
      let je = rest[0], de = Infinity;
      for (const j of rest) {
        const d = dist(end, j);
        if (d < de) {
          de = d;
          je = j;
        }
      }
      let js = rest[0], ds = Infinity;
      for (const j of rest) {
        const d = dist(s0, j);
        if (d < ds) {
          ds = d;
          js = j;
        }
      }
      if (ds < de) {
        order = order.reverse();
        end = order[order.length - 1];
        je = js;
      }
      let cur = je;
      used[je] = true;
      const sub = [je];
      for (;;) {
        let best = -1, bd = Infinity;
        for (const j of adj[cur]) {
          if (used[j]) continue;
          const d = dist(cur, j);
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        if (best < 0) break;
        used[best] = true;
        sub.push(best);
        cur = best;
      }
      order = order.concat(sub);
    }

    // ── 5) 2-opt — 끊김 수 우선 줄이고, 그다음 총 사잇선 길이를 줄여 '선 꼬임(교차)'을 없앤다. ──
    const cost = (seq: number[]): [number, number] => {
      let brk = 0, tot = 0;
      for (let k = 0; k < seq.length - 1; k++) {
        const d = dist(seq[k], seq[k + 1]);
        tot += d;
        if (d > maxLink) brk++;
      }
      return [brk, tot];
    };
    let [curBrk, curTot] = cost(order);
    if (N <= SOLVE_MAX_N) {
      let improved = true, pass = 0;
      while (improved && pass < 30) {
        improved = false;
        pass++;
        for (let a = 0; a < N - 1; a++) {
          for (let bIdx = a + 2; bIdx < N; bIdx++) {
            const next = order.slice(0, a + 1).concat(order.slice(a + 1, bIdx + 1).reverse(), order.slice(bIdx + 1));
            const [nb, nt] = cost(next);
            if (nb < curBrk || (nb === curBrk && nt + 1e-6 < curTot)) {
              order = next;
              curBrk = nb;
              curTot = nt;
              improved = true;
            }
          }
        }
      }
    }

    // ── 6) 끊김 메우기 — 분기 글자(㈈류)처럼 한붓그리기 불가라 사잇선 초과(>예산) 간격이 남으면, 그 자리에
    //   '딱 붙여' 브릿지 모듈을 끼워 단일 체인 유지(사장님: 180도 꺾는 자리엔 1개 붙여도 OK). 끊김 0 보장. ──
    // 사장님: 사잇선/고무캡/혓바닥 무시하고 '모듈만' 균일 배치 → 사잇선 잇는 브릿지 모듈 안 끼움(개수 정확·깔끔).
    const chain: { cx: number; cy: number }[] = order.map((i) => real(G[i].sx, G[i].sy));
    // 끝이 배선쪽이 되게(소프트) — 시작 고무캡은 반대쪽.
    const endScore = (cx: number, cy: number) => cx * (v[0] + towardX * 0.35) + cy * v[1];
    const oc: { cx: number; cy: number; deg?: number }[] =
      endScore(chain[chain.length - 1].cx, chain[chain.length - 1].cy) < endScore(chain[0].cx, chain[0].cy) ? chain.slice().reverse() : chain;

    // ── 7) 모듈 방향(PCA=국소 획 방향) + 테두리 안으로 밀어넣기(각도·이동으로 빡빡한 교차점도 들어가게). ──
    //   사장님: 임의 회전 금지(획 따라 1자), 모듈이 테두리 뚫으면 안 됨(딱 닿는 건 OK), 끝 혓바닥은 무조건 밖.
    const fx = w * 0.46,
      fy = bh * 0.46;
    const offs: [number, number][] = [[fx, 0], [-fx, 0], [0, fy], [0, -fy], [fx, fy], [fx, -fy], [-fx, fy], [-fx, -fy]];
    const R2 = (w * 1.5) ** 2;
    const pcaDeg = (k: number): number => {
      const cx = oc[k].cx, cy = oc[k].cy;
      let sxx = 0, syy = 0, sxy = 0, n = 0;
      for (const p of oc) {
        const dx = p.cx - cx, dy = p.cy - cy;
        if (dx * dx + dy * dy <= R2) { sxx += dx * dx; syy += dy * dy; sxy += dx * dy; n++; }
      }
      if (n < 2) return 0;
      return (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
    };
    const snapAxis = (a: number): number => {
      // 가까운 축(가로0/세로90)으로 강하게 스냅 — 넓은 격자 구간을 깔끔히 정렬(비스듬한 PCA 잡음 제거).
      const m = ((a % 180) + 180) % 180;
      return m < 45 || m > 135 ? 0 : 90;
    };
    const snapDeg = (a: number): number => {
      const m = ((a % 180) + 180) % 180;
      if (m < 20 || m > 160) return 0;
      if (m > 70 && m < 110) return 90;
      return a;
    };
    const violAt = (cx: number, cy: number, deg: number): number => {
      const rad = (deg * Math.PI) / 180,
        ux = Math.cos(rad),
        uy = Math.sin(rad),
        px = -uy,
        py = ux;
      let c = 0;
      for (const [ox, oy] of offs) if (!pointInPolys(polys, cx + ux * ox + px * oy, cy + uy * ox + py * oy)) c++;
      return c;
    };
    const nudge = (cx0: number, cy0: number, deg: number): [number, number, number] => {
      const rad = (deg * Math.PI) / 180,
        ux = Math.cos(rad),
        uy = Math.sin(rad),
        px = -uy,
        py = ux;
      let cx = cx0,
        cy = cy0;
      for (let it = 0; it < 20; it++) {
        let mx = 0,
          my = 0,
          nb = 0;
        for (const [ox, oy] of offs)
          if (!pointInPolys(polys, cx + ux * ox + px * oy, cy + uy * ox + py * oy)) {
            mx += ox;
            my += oy;
            nb++;
          }
        if (nb === 0) return [cx, cy, 0];
        mx /= nb;
        my /= nb;
        cx -= (ux * mx + px * my) * 0.5;
        cy -= (uy * mx + py * my) * 0.5;
      }
      return [cx, cy, violAt(cx, cy, deg)];
    };
    const shifts = [0, w * 0.3, -w * 0.3, w * 0.55, -w * 0.55, w * 0.8, -w * 0.8];
    const perps = [0, bh * 0.6, -bh * 0.6];
    for (let k = 0; k < oc.length; k++) {
      const a = oc[Math.max(0, k - 1)],
        b = oc[Math.min(oc.length - 1, k + 1)];
      let tx = b.cx - a.cx,
        ty = b.cy - a.cy;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const ppx = -ty,
        ppy = tx;
      // 모듈 각도(사장님 규칙, w=모듈 길이): 폭≈모듈길이(≤1.2w)=1자 / 1.2~2w=살짝 회전(최대45°) / ≥2w=2줄(sw=0, 축정렬).
      //   직선 획은 축(가로0/세로90)으로 스냅해 깔끔하게, 명확한 대각선 획(ㅅ·ㅈ·4 등)만 그대로.
      const swk = swMap.get(Math.round(oc[k].cx) + ',' + Math.round(oc[k].cy)) ?? 0;
      const pcd = pcaDeg(k);
      const mAng = ((pcd % 180) + 180) % 180;
      const isDiag = (mAng > 33 && mAng < 57) || (mAng > 123 && mAng < 147);
      let base: number;
      if (isDiag) base = pcd;
      else if (swk > w * 1.2 && swk < w * 2) base = snapAxis(pcd) + 45 * ((swk - w * 1.2) / (w * 0.8));
      else base = snapAxis(pcd);
      const angCands = [snapDeg(base), base, base + 10, base - 10, base + 20, base - 20, base + 30, base - 30, base + 45, base - 45, base + 60, base - 60, base + 75, base - 75, 0, 90];
      let bestCx = oc[k].cx,
        bestCy = oc[k].cy,
        bestDeg = snapDeg(base),
        bestViol = 99,
        found = false;
      for (const sh of shifts) {
        for (const pp of perps) {
          const sx = oc[k].cx + tx * sh + ppx * pp,
            sy = oc[k].cy + ty * sh + ppy * pp;
          for (const ang of angCands) {
            const [nx, ny, vv] = nudge(sx, sy, ang);
            if (vv < bestViol) {
              bestViol = vv;
              bestCx = nx;
              bestCy = ny;
              bestDeg = ang;
              if (vv === 0) {
                found = true;
                break;
              }
            }
          }
          if (found) break;
        }
        if (found) break;
      }
      oc[k] = { cx: bestCx, cy: bestCy, deg: bestDeg };
    }

    // (사장님: 모듈만 — 사잇선 잇는 브릿지 안 끼움. 개수 = 목표 그대로 정확.)
    const oc2 = oc;

    // ── 9) 겹친 모듈 분리 — 두 모듈이 본체 겹칠만큼 가까우면 서로 반대로 밀어 떼고 다시 안으로 너지. ──
    const sepD = bh * 1.35; // 이보다 가까우면 겹침으로 보고 분리(정상 2줄 간격은 더 멀어 안 건드림).
    for (let it = 0; it < 4; it++) {
      let moved = false;
      for (let i = 0; i < oc2.length; i++)
        for (let j = i + 1; j < oc2.length; j++) {
          const dx = oc2[j].cx - oc2[i].cx, dy = oc2[j].cy - oc2[i].cy;
          const d = Math.hypot(dx, dy);
          if (d < sepD) {
            const ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
            const push = (sepD - d) / 2 + 0.5;
            const [ax, ay] = nudge(oc2[i].cx - ux * push, oc2[i].cy - uy * push, oc2[i].deg ?? 0);
            const [bx2, by2] = nudge(oc2[j].cx + ux * push, oc2[j].cy + uy * push, oc2[j].deg ?? 0);
            oc2[i] = { ...oc2[i], cx: ax, cy: ay };
            oc2[j] = { ...oc2[j], cx: bx2, cy: by2 };
            moved = true;
          }
        }
      if (!moved) break;
    }

    // 시작/끝 LED·혓바닥·배선 개념 제거 — 모듈만 균일 배치(개수=면적/둘레 학습값). chains 는 위치+회전만.
    return { count: oc2.length, spec, chains: [oc2], rows: [] };
  }

  // 연속형(줄엘이디/PCB) — 면적+둘레 선형모델: count = 면적/areaPerLed + 둘레/perimPerLed
  // 순수 면적(area/K)은 좁은 글자(ASPESI)가 면적당 1.7배 빽빽한 걸 못 잡음(획이 좁아 가장자리 비중↑).
  // 둘레항이 좁은 획(둘레/면적 큼)에 가중 → GUNP+ASPESI 10글자(폭 28~82mm) 모두 글자별 ±3개로 맞음.
  // 면적은 스캔(spansAt 은 even-odd 라 구멍 자동 제외), 둘레는 모든 폴리(바깥+구멍) 합(스트립이 안쪽 가장자리도 따라감).
  // 개수 = 통합 측정값(runMetrics: 200줄 면적 + 둘레). 모듈/연속형/학습 POST 모두 같은 값 사용.
  const areaPerLed = spec.areaPerLed!;
  const perimPerLed = spec.perimPerLed!;
  const { area, perim } = runMetrics(polys);
  const count = Math.max(1, Math.round(area / areaPerLed + perim / perimPerLed));
  // rows[] 는 시각용(가로 스트립 줄) — 개수와 무관, 채움 표시만.
  const rowPitch0 = spec.rowPitch!;
  const ny = Math.max(1, Math.round(bb.h / rowPitch0));
  const rowPitch = bb.h / ny;
  const rows: { cy: number; segs: [number, number][] }[] = [];
  for (let r = 0; r < ny; r++) {
    const cy = bb.minY + rowPitch * (r + 0.5);
    const segs = spansAt(polys, cy);
    if (segs.length) rows.push({ cy, segs });
  }
  return { count, spec, chains: [], rows, note: '면적+둘레 실측모델(줄엘이디)' };
}
