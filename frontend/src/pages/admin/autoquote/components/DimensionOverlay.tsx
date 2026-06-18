/**
 * 지시서 위 '오브젝트별/구간 가로세로(mm)' 측정 오버레이 (치수 모드).
 *
 * 워처가 인쇄 시 .fs→DXF 로 추출해 서버에 올린 지오메트리(mm)를 받아, 명세서 작성 화면의 지시서 사진
 * 위에 투명 측정 레이어로 깐다. 치수 모드(active)에서:
 *  - 마우스 올리면(호버) 그 오브젝트 테두리 강조 + 'W×H mm' 라벨.
 *  - 짧게 클릭 = 그 오브젝트 라벨 고정(토글).
 *  - 드래그(마퀴) = 박스 안에 들어온 오브젝트들의 '끝에서 끝까지' 합산 크기 표시(일반 디자인 툴처럼).
 *
 * 좌표계: 이 SVG 는 AutoQuote 의 .aq-stage(콘텐츠 픽셀, transform:scale(zoom)) 안에 들어가 이미지와 함께
 * 스케일된다. 마우스 클라이언트 좌표 → 콘텐츠 좌표는 getScreenCTM().inverse() 로 변환(줌/팬 자동 반영).
 * DXF extent → 이미지 매핑은 contentBox(흰 여백 제외 실제 내용 영역, 정확)가 있으면 거기에, 없으면 fit-가운데.
 * DXF 는 Y 위쪽 → 화면 Y 아래쪽이라 뒤집는다.
 */
import { useMemo, useRef, useState } from 'react';

export interface DimObject {
  x: number;
  y: number;
  w: number;
  h: number;
  type?: string;
}

export interface DimGeom {
  unit_mm: number;
  extent: { x: number; y: number; w: number; h: number } | null;
  objects: DimObject[];
  // 워처가 인쇄 PDF 에서 계산한 '실제 벡터(아트워크) 영역'(0..1, 회전 반영). 있으면 정렬 기준 1순위.
  page_box?: { x: number; y: number; w: number; h: number } | null;
}

interface Props {
  geom: DimGeom | null;
  stageW: number;
  stageH: number;
  zoom: number;
  active: boolean;
  contentBox?: { x: number; y: number; w: number; h: number } | null;
}

interface Mapped {
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

const TEAL = '#0a9396';

export default function DimensionOverlay({ geom, stageW, stageH, zoom, active, contentBox }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number[]>([]);
  // 드래그(마퀴) — 진행 중 박스(콘텐츠 좌표). 끝나면 selection 결과로.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drag = useRef<{ x0: number; y0: number; moved: boolean } | null>(null);
  // 마퀴 선택 결과 — 합산 박스(화면) + 합산 mm.
  const [sel, setSel] = useState<{ sx: number; sy: number; sw: number; sh: number; mw: number; mh: number } | null>(null);

  const mapped = useMemo<Mapped[]>(() => {
    if (!geom || !geom.extent || !stageW || !stageH) return [];
    const ext = geom.extent;
    if (ext.w <= 0 || ext.h <= 0) return [];
    let cw: number;
    let ch: number;
    let ox: number;
    let oy: number;
    const pb = geom.page_box;
    if (pb && pb.w > 0 && pb.h > 0) {
      // ★ 워처가 인쇄 PDF 에서 계산한 '실제 벡터(아트워크) 영역'. DXF extent(=벡터 bbox)가 여기에 정확히
      //   들어맞는다(종횡비 일치 확인). 전체 잉크 bbox 휴리스틱/anchor 불필요 — page_box 에 직접 채운다.
      cw = pb.w * stageW;
      ch = pb.h * stageH;
      ox = pb.x * stageW;
      oy = pb.y * stageH;
    } else if (contentBox && contentBox.w > 0 && contentBox.h > 0) {
      // contentBox(흰 여백 뺀 잉크 영역) 안에 DXF 본래 비율을 유지해 'contain' 배치.
      // 늘려 채우면 인쇄 이미지에 섞인 여분 잉크(텍스트 디센더·인쇄 추가요소)만큼 세로가 밀리므로,
      // 비율 보존 + 짧은 축은 가운데 정렬해 어긋남을 없앤다. (가로가 이미 맞던 경우 가로는 그대로.)
      const bx = contentBox.x * stageW;
      const by = contentBox.y * stageH;
      const bw = contentBox.w * stageW;
      const bh = contentBox.h * stageH;
      // 가로(ink bbox 폭)는 아트워크 폭과 정확히 일치함이 확인됨 → 가로를 '기준축'으로 고정(폭 그대로).
      // 세로 스케일(ch)도 가로 스케일과 동일(DXF 1:1 등방)하므로 비율로 계산하면 '크기'는 정확.
      // 남은 건 세로 '위치'(균일 오프셋). DXF extent 는 벡터객체만(글자 제외)이고 이미지 ink bbox 는
      // 글자/주석까지 포함해 둘의 세로 경계가 달라 anchor 가 어긋난다. 작업자 주석이 위쪽에 있어
      // 아트워크가 잉크영역 '아래'에 정렬되는 케이스라 bottom-anchor 로 맞춘다.
      const ea = ext.w / ext.h;
      cw = bw;
      ch = bw / ea;
      ox = bx;
      oy = by + (bh - ch); // bottom-anchor: 아트워크 바닥 = 잉크영역 바닥
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
    // 큰 것 먼저(뒤), 작은 것 나중(앞) → 겹칠 때 작은(구체) 오브젝트가 히트테스트에 먼저 잡힘.
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
  }, [geom, stageW, stageH, contentBox]);

  if (!active || !geom || !geom.extent || mapped.length === 0) return null;

  // 클라이언트 좌표 → 콘텐츠(SVG) 좌표 (줌/팬 자동 반영).
  const toContent = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  // 오브젝트 '테두리(외곽선)'까지의 거리. 안쪽이면 가장 가까운 변까지, 바깥이면 사각형 경계까지.
  const distToOutline = (m: Mapped, x: number, y: number): number => {
    const l = m.sx;
    const t = m.sy;
    const r = m.sx + m.sw;
    const b = m.sy + m.sh;
    if (x >= l && x <= r && y >= t && y <= b) {
      return Math.min(x - l, r - x, y - t, b - y); // 안쪽: 가장 가까운 변까지
    }
    const cx = Math.max(l, Math.min(x, r));
    const cy = Math.max(t, Math.min(y, b));
    return Math.hypot(x - cx, y - cy); // 바깥: 사각형 경계까지
  };

  // 클릭/호버 = '테두리가 닿은' 오브젝트(점을 품는 큰 박스가 아님). tol 이내에서 테두리가 가장 가까운 것,
  // 동률이면 작은 것. → 큰 네모박스 안 빈 곳을 클릭하면(테두리 멀어) 안 잡히고, 안쪽 항목 테두리 근처를
  // 클릭하면 그 항목이 잡힌다. (사용자 요구: 벡터 테두리가 클릭된 것을 선택)
  const hitTest = (x: number, y: number): number | null => {
    const tol = 8 / zoom; // 화면 8px 상당(줌 보정)
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
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 스테이지 패닝 방지(치수 모드에선 드래그=마퀴).
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    drag.current = { x0: p.x, y0: p.y, moved: false };
    setSel(null);
    setHover(null); // 드래그 시작 — 호버 라벨 끔(드래그 결과만 보이게).
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onMove = (e: React.MouseEvent) => {
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    if (drag.current) {
      const dx = Math.abs(p.x - drag.current.x0);
      const dy = Math.abs(p.y - drag.current.y0);
      if (dx > 3 || dy > 3) drag.current.moved = true;
      setMarquee({ x0: drag.current.x0, y0: drag.current.y0, x1: p.x, y1: p.y });
    } else {
      setHover(hitTest(p.x, p.y));
    }
  };

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    setMarquee(null);
    if (!d) return;
    e.stopPropagation();
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    if (!d.moved) {
      // 짧은 클릭 = 단일 오브젝트 라벨 토글.
      const hit = hitTest(p.x, p.y);
      if (hit != null) {
        setPinned((arr) => (arr.includes(hit) ? arr.filter((x) => x !== hit) : [...arr, hit]));
      }
      return;
    }
    // 마퀴 = 박스에 닿은 오브젝트들의 '끝에서 끝까지' 합산 크기.
    const rx0 = Math.min(d.x0, p.x);
    const ry0 = Math.min(d.y0, p.y);
    const rx1 = Math.max(d.x0, p.x);
    const ry1 = Math.max(d.y0, p.y);
    // 마퀴(드래그)에 '테두리가 닿은' 오브젝트만. 단, 마퀴를 통째로 감싸는 컨테이너 박스(테두리가 마퀴
    // 바깥)는 제외 → 큰 네모박스 안에서 작업내용들을 드래그하면 안쪽 항목들만 잡히고 바깥 박스는 빠진다.
    // (박스를 잡고 싶으면 박스 바깥까지 크게 드래그하면 마퀴가 박스를 감싸지 않게 돼 포함된다.)
    const inside = mapped.filter((m) => {
      const overlaps = m.sx < rx1 && m.sx + m.sw > rx0 && m.sy < ry1 && m.sy + m.sh > ry0;
      if (!overlaps) return false;
      const wrapsMarquee = m.sx < rx0 && m.sy < ry0 && m.sx + m.sw > rx1 && m.sy + m.sh > ry1;
      return !wrapsMarquee;
    });
    if (inside.length === 0) {
      setSel(null);
      return;
    }
    const sx = Math.min(...inside.map((m) => m.sx));
    const sy = Math.min(...inside.map((m) => m.sy));
    const sxe = Math.max(...inside.map((m) => m.sx + m.sw));
    const sye = Math.max(...inside.map((m) => m.sy + m.sh));
    const mxx = Math.min(...inside.map((m) => m.mx));
    const myy = Math.min(...inside.map((m) => m.my));
    const mxe = Math.max(...inside.map((m) => m.mx + m.mw));
    const mye = Math.max(...inside.map((m) => m.my + m.mh));
    // 드래그(구간) 선택이 클릭(핀)을 대체 — 같은 객체가 둘 다 당했으면 드래그한 합산 결과만 보인다.
    setPinned([]);
    setSel({ sx, sy, sw: sxe - sx, sh: sye - sy, mw: mxe - mxx, mh: mye - myy });
  };

  const shown = mapped.filter((m) => hover === m.i || pinned.includes(m.i));
  const lw = 1.5 / zoom;

  return (
    <svg
      ref={svgRef}
      className="aq-dimsvg"
      style={{ position: 'absolute', left: 0, top: 0, width: stageW, height: stageH, overflow: 'visible', cursor: 'crosshair' }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={() => {
        setHover(null);
        if (drag.current) {
          drag.current = null;
          setMarquee(null);
        }
      }}
    >
      {/* 이벤트 캡처용 투명 배경(전체 스테이지) — 빈 곳 드래그도 마퀴로 잡고 스테이지 패닝 차단. */}
      <rect x={0} y={0} width={stageW} height={stageH} fill="transparent" />

      {/* 호버/핀된 단일 오브젝트 강조 */}
      {shown.map((m) => (
        <rect
          key={m.i}
          x={m.sx}
          y={m.sy}
          width={m.sw}
          height={m.sh}
          fill="rgba(10,147,150,0.12)"
          stroke={TEAL}
          strokeWidth={lw}
          pointerEvents="none"
        />
      ))}

      {/* 마퀴(드래그 중) */}
      {marquee && (
        <rect
          x={Math.min(marquee.x0, marquee.x1)}
          y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)}
          height={Math.abs(marquee.y1 - marquee.y0)}
          fill="rgba(10,147,150,0.08)"
          stroke={TEAL}
          strokeWidth={lw}
          strokeDasharray={`${5 / zoom} ${4 / zoom}`}
          pointerEvents="none"
        />
      )}

      {/* 마퀴 선택 결과(합산 박스 + 끝-끝 mm) */}
      {sel && (
        <g pointerEvents="none">
          <rect
            x={sel.sx}
            y={sel.sy}
            width={sel.sw}
            height={sel.sh}
            fill="rgba(238,155,0,0.10)"
            stroke="#ee9b00"
            strokeWidth={2 / zoom}
          />
          <g transform={`translate(${sel.sx + sel.sw / 2}, ${sel.sy}) scale(${1 / zoom})`}>
            <text y={-6} textAnchor="middle" fontSize={14} fontWeight={800} fill="#ca6702" stroke="#fff" strokeWidth={3.5} paintOrder="stroke">
              {`${sel.mw.toFixed(1)} × ${sel.mh.toFixed(1)} mm`}
            </text>
          </g>
        </g>
      )}

      {/* 호버/핀 단일 라벨 — 확대해도 크기 유지(scale 1/zoom), 흰 외곽선. */}
      {shown.map((m) => (
        <g key={`l${m.i}`} transform={`translate(${m.sx + m.sw / 2}, ${m.sy}) scale(${1 / zoom})`} pointerEvents="none">
          <text y={-5} textAnchor="middle" fontSize={13} fontWeight={700} fill={TEAL} stroke="#ffffff" strokeWidth={3} paintOrder="stroke">
            {`${m.mw.toFixed(1)} × ${m.mh.toFixed(1)} mm`}
          </text>
        </g>
      ))}
    </svg>
  );
}
