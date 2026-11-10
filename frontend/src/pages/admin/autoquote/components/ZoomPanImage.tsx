/**
 * 확대·이동되는 이미지 — 단서로 찾기에서 지시서의 작은 글씨를 보면서 단서를 칠 수 있게.
 *  - 휠 = 마우스 위치 기준 확대/축소, 끌기 = 이동, 더블클릭 = 다시 맞춤
 *  - 처음엔 상자에 맞춤(contain). 상태는 이 컴포넌트 안에서만(창을 닫으면 초기화).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  src: string;
  alt?: string;
}

export default function ZoomPanImage({ src, alt }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const reset = useCallback(() => setT({ s: 1, x: 0, y: 0 }), []);
  useEffect(reset, [src, reset]);

  // React 의 onWheel 은 passive 라 preventDefault 가 안 먹음 → 직접 등록(모달 뒤 페이지 스크롤 방지).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setT((p) => {
        const s = Math.min(10, Math.max(1, p.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        if (s === 1) return { s: 1, x: 0, y: 0 };
        // 마우스 아래 지점이 그대로 있게 이동량 보정
        const k = s / p.s;
        return { s, x: mx - (mx - p.x) * k, y: my - (my - p.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={boxRef}
      className="aq-zoomimg"
      onPointerDown={(e) => {
        if (t.s === 1) return;
        drag.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setT((p) => ({ ...p, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={reset}
      style={{ cursor: t.s > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: '0 0' }}
      />
      <div className="aq-zoomimg-hint">{t.s > 1 ? `${Math.round(t.s * 100)}% · 끌어서 이동 · 더블클릭=맞춤` : '휠로 확대'}</div>
    </div>
  );
}
