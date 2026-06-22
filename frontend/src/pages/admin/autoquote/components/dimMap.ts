/**
 * 지시서 위 벡터 오버레이(치수/LED 공용) — DXF 지오메트리(mm) → 화면(콘텐츠 px) 매핑과 히트테스트.
 *
 * 치수 오버레이(DimensionOverlay)와 LED 계산 오버레이(LedOverlay)가 '똑같은' 정렬/선택 로직을 쓰도록
 * 순수 함수로 분리했다. 정렬은 page_box(워처가 인쇄 PDF 에서 계산한 실제 아트워크 영역) 1순위 →
 * contentBox(이미지 흰 여백 제외) → fit-가운데 폴백 순. (정렬 근거는 DimensionOverlay 주석 참고)
 */

export interface DimObject {
  x: number;
  y: number;
  w: number;
  h: number;
  type?: string;
  // 워처가 올린 실제 윤곽 꼭짓점(mm, DXF Y=위쪽 원좌표). 있으면 LED 모드에서 실제 테두리/채움에 사용.
  points?: number[][];
}

export interface DimGeom {
  unit_mm: number;
  extent: { x: number; y: number; w: number; h: number } | null;
  objects: DimObject[];
  // 워처가 인쇄 PDF 에서 계산한 '실제 벡터(아트워크) 영역'(0..1, 회전 반영). 있으면 정렬 기준 1순위.
  page_box?: { x: number; y: number; w: number; h: number } | null;
}

export interface Mapped {
  i: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number; // 화면(콘텐츠 px)
  mx: number;
  my: number;
  mw: number;
  mh: number; // 실측 mm
}

type Box = { x: number; y: number; w: number; h: number } | null | undefined;

/** DXF extent(mm) → 화면(콘텐츠 px) 선형 변환 계수. cw/ch=내용폭/높이, ox/oy=좌상단 오프셋. */
export interface Projection {
  ox: number;
  oy: number;
  cw: number;
  ch: number;
  ext: { x: number; y: number; w: number; h: number };
}

/** geom + 스테이지 크기 → 투영 계수. page_box → contentBox → fit-가운데 순서로 배치 결정. */
export function computeProjection(geom: DimGeom | null, stageW: number, stageH: number, contentBox?: Box): Projection | null {
  if (!geom || !geom.extent || !stageW || !stageH) return null;
  const ext = geom.extent;
  if (ext.w <= 0 || ext.h <= 0) return null;
  let cw: number;
  let ch: number;
  let ox: number;
  let oy: number;
  const pb = geom.page_box;
  if (pb && pb.w > 0 && pb.h > 0) {
    cw = pb.w * stageW;
    ch = pb.h * stageH;
    ox = pb.x * stageW;
    oy = pb.y * stageH;
  } else if (contentBox && contentBox.w > 0 && contentBox.h > 0) {
    const bx = contentBox.x * stageW;
    const by = contentBox.y * stageH;
    const bw = contentBox.w * stageW;
    const bh = contentBox.h * stageH;
    const ea = ext.w / ext.h;
    cw = bw;
    ch = bw / ea;
    ox = bx;
    oy = by + (bh - ch); // bottom-anchor
  } else {
    const ea = ext.w / ext.h;
    const ia = stageW / stageH;
    if (ea > ia) {
      cw = stageW;
      ch = stageW / ea;
      ox = 0;
      oy = (stageH - ch) / 2;
    } else {
      ch = stageH;
      cw = stageH * ea;
      ox = (stageW - cw) / 2;
      oy = 0;
    }
  }
  return { ox, oy, cw, ch, ext };
}

/** mm 점(DXF Y=위쪽) → 화면(콘텐츠 px). Y 뒤집기 포함. */
export function projectPoint(p: Projection, mx: number, my: number): { x: number; y: number } {
  return {
    x: p.ox + ((mx - p.ext.x) / p.ext.w) * p.cw,
    y: p.oy + (1 - (my - p.ext.y) / p.ext.h) * p.ch, // DXF Y 위쪽 → 화면 Y 아래쪽
  };
}

/** geom.objects → 화면 좌표(Mapped[]). 큰 것 먼저(뒤)·작은 것 나중(앞)으로 정렬해 겹칠 때 작은 게 먼저 잡힘. */
export function computeMapped(geom: DimGeom | null, stageW: number, stageH: number, contentBox?: Box): Mapped[] {
  const proj = computeProjection(geom, stageW, stageH, contentBox);
  if (!proj || !geom) return [];
  const { ox, oy, cw, ch, ext } = proj;
  return geom.objects
    .map((o, i) => ({ o, i }))
    .sort((a, b) => b.o.w * b.o.h - a.o.w * a.o.h)
    .map(({ o, i }) => {
      const nx = (o.x - ext.x) / ext.w;
      const ny = (o.y - ext.y) / ext.h;
      const nw = o.w / ext.w;
      const nh = o.h / ext.h;
      return {
        i,
        sx: ox + nx * cw,
        sy: oy + (1 - ny - nh) * ch, // DXF Y 위쪽 → 화면 Y 아래쪽
        sw: nw * cw,
        sh: nh * ch,
        mx: o.x,
        my: o.y,
        mw: o.w,
        mh: o.h,
      };
    });
}

/** 오브젝트 '테두리(외곽선)'까지의 거리. 안쪽이면 가장 가까운 변까지, 바깥이면 사각형 경계까지. */
export function distToOutline(m: Mapped, x: number, y: number): number {
  const l = m.sx;
  const t = m.sy;
  const r = m.sx + m.sw;
  const b = m.sy + m.sh;
  if (x >= l && x <= r && y >= t && y <= b) {
    return Math.min(x - l, r - x, y - t, b - y);
  }
  const cx = Math.max(l, Math.min(x, r));
  const cy = Math.max(t, Math.min(y, b));
  return Math.hypot(x - cx, y - cy);
}

/** 점(px)에서 선분 [a,b](px)까지 최단거리. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 실제 외곽선(points) 기준 정밀 히트테스트 — bbox 가 아니라 진짜 곡선/획 위를 클릭할 수 있게.
 * 1) mapped 의 bbox 로 후보를 싸게 거르고(확장 tol 내), 2) 그 후보만 실제 꼭짓점을 화면으로 투영해
 *    외곽선까지 최단거리를 잰다. points 없는(옛 데이터) 오브젝트는 bbox 외곽선 거리로 폴백.
 *
 * 선택 규칙: 얇은 선을 잡기 쉽게 tol(여유)을 넉넉히 준다. 단 선끼리 겹친 곳에서 둘 다 잡히면 곤란하므로,
 * '가장 가까운 선'에서 SEP 안쪽으로 비슷하게 가까운 후보들 중 '가장 작은(=안쪽) 것'을 고른다. 그러면
 * 안쪽 선은 제자리(겹친 지점)에서 우선권을 갖고, 바깥 선은 그 선 쪽으로 SEP 만큼 더 벗어나야(밀려난
 * 위치) 잡힌다 → 호버/클릭이 안쪽·바깥을 또렷이 구분.
 */
export function hitTestPolys(mapped: Mapped[], objects: DimObject[], proj: Projection, x: number, y: number, zoom: number): number | null {
  const tol = 9 / zoom; // 얇은 선 여유(클릭박스)
  const sep = 6 / zoom; // 겹친 선 분리 마진 — 이 차이 안이면 안쪽 우선, 바깥은 더 벗어나야 잡힘
  const cands: { i: number; d: number; area: number }[] = [];
  for (const m of mapped) {
    // bbox 프리필터 — 확장된 bbox 밖이면 외곽선도 멀다.
    if (x < m.sx - tol || x > m.sx + m.sw + tol || y < m.sy - tol || y > m.sy + m.sh + tol) continue;
    const pts = objects[m.i]?.points;
    let d: number;
    if (!pts || pts.length < 2) {
      d = distToOutline(m, x, y);
    } else {
      d = Infinity;
      let prev = projectPoint(proj, pts[0][0], pts[0][1]);
      for (let k = 1; k <= pts.length; k++) {
        const q = pts[k % pts.length];
        const cur = projectPoint(proj, q[0], q[1]);
        const dd = segDist(x, y, prev.x, prev.y, cur.x, cur.y);
        if (dd < d) d = dd;
        prev = cur;
        if (d === 0) break;
      }
    }
    if (d <= tol) cands.push({ i: m.i, d, area: m.sw * m.sh });
  }
  if (!cands.length) return null;
  let minD = Infinity;
  for (const c of cands) if (c.d < minD) minD = c.d;
  // 가장 가까운 선에서 sep 안쪽으로 비슷한 후보들 중 가장 작은(안쪽) 것.
  let pick: { i: number; d: number; area: number } | null = null;
  for (const c of cands) {
    if (c.d > minD + sep) continue;
    if (!pick || c.area < pick.area) pick = c;
  }
  return pick ? pick.i : null;
}

/** 클릭/호버 = '테두리가 닿은' 오브젝트. tol 이내에서 테두리가 가장 가까운 것, 동률이면 작은 것. */
export function hitTest(mapped: Mapped[], x: number, y: number, zoom: number): number | null {
  const tol = 8 / zoom;
  let best: Mapped | null = null;
  let bestD = Infinity;
  for (const m of mapped) {
    const d = distToOutline(m, x, y);
    if (d > tol) continue;
    if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && best && m.sw * m.sh < best.sw * best.sh)) {
      best = m;
      bestD = d;
    }
  }
  return best ? best.i : null;
}
