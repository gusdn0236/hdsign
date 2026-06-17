/**
 * 지시서 위 '오브젝트별 가로세로(mm)' 오버레이.
 *
 * 워처가 인쇄 시 .fs→DXF 로 추출해 서버에 올린 지오메트리(mm)를 받아, 명세서 작성 화면의 지시서
 * 사진 위에 투명 클릭영역으로 깐다. 마우스 올리면 그 오브젝트 테두리 강조, 클릭하면 'W×H mm' 라벨
 * 고정(다시 클릭하면 해제). 평소엔 지시서 사진이 그대로 보이고, '치수 모드'일 때만 활성(active).
 *
 * 좌표계: 이 SVG 는 AutoQuote 의 .aq-stage(콘텐츠 픽셀 좌표, transform:scale(zoom)) 안에 들어가므로
 * 이미지 자연 픽셀(stageW×stageH) 좌표로 그린다. DXF 는 mm·원점 좌하단·Y 위쪽 → 화면은 Y 아래쪽이라
 * 뒤집는다. DXF 전체 extent 를 이미지에 'fit + 가운데' 로 매핑(인쇄가 도면을 페이지에 맞춰 넣는다는 가정).
 * 정렬이 어긋나면 실제 주문으로 보정 로직을 더한다(현장 검증 항목).
 */
import { useMemo, useState } from 'react';

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
}

interface Props {
  geom: DimGeom | null;
  stageW: number;
  stageH: number;
  zoom: number;
  active: boolean;
}

interface Mapped {
  i: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

export default function DimensionOverlay({ geom, stageW, stageH, zoom, active }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number[]>([]);

  const mapped = useMemo<Mapped[]>(() => {
    if (!geom || !geom.extent || !stageW || !stageH) return [];
    const ext = geom.extent;
    if (ext.w <= 0 || ext.h <= 0) return [];
    // 도면 전체(extent)를 이미지에 비율유지 fit + 가운데 정렬.
    const ea = ext.w / ext.h;
    const ia = stageW / stageH;
    let cw: number;
    let ch: number;
    let ox: number;
    let oy: number;
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
    // 큰 것 먼저(뒤), 작은 것 나중(앞) → 겹칠 때 작은(구체) 오브젝트가 호버/클릭에 먼저 잡힘.
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
          w: o.w,
          h: o.h,
        };
      });
  }, [geom, stageW, stageH]);

  if (!active || !geom || !geom.extent || mapped.length === 0) return null;

  const shown = mapped.filter((m) => hover === m.i || pinned.includes(m.i));

  return (
    <svg
      className="aq-dimsvg"
      style={{ position: 'absolute', left: 0, top: 0, width: stageW, height: stageH, overflow: 'visible' }}
    >
      {mapped.map((m) => {
        const on = hover === m.i || pinned.includes(m.i);
        return (
          <rect
            key={m.i}
            x={m.sx}
            y={m.sy}
            width={m.sw}
            height={m.sh}
            fill={on ? 'rgba(10,147,150,0.12)' : 'transparent'}
            stroke={on ? '#0a9396' : 'none'}
            strokeWidth={1.5 / zoom}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHover(m.i)}
            onMouseLeave={() => setHover((h) => (h === m.i ? null : h))}
            onClick={() =>
              setPinned((p) => (p.includes(m.i) ? p.filter((x) => x !== m.i) : [...p, m.i]))
            }
          />
        );
      })}
      {/* 라벨 — 호버/핀된 것만. 확대해도 크기 유지(scale 1/zoom), 흰 외곽선으로 가독성. */}
      {shown.map((m) => (
        <g
          key={`l${m.i}`}
          transform={`translate(${m.sx + m.sw / 2}, ${m.sy}) scale(${1 / zoom})`}
          style={{ pointerEvents: 'none' }}
        >
          <text
            y={-5}
            textAnchor="middle"
            fontSize={13}
            fontWeight={700}
            fill="#0a9396"
            stroke="#ffffff"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {`${Math.round(m.w)} × ${Math.round(m.h)} mm`}
          </text>
        </g>
      ))}
    </svg>
  );
}
