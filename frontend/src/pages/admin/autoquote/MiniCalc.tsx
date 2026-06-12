import { useRef, useState, type ComponentType } from 'react';
import { usePrices } from '../calc/usePrices';
import AcrylCalc from '../calc/AcrylCalc.jsx';
import ChannelCalc from '../calc/ChannelCalc.jsx';
import LedCalc from '../calc/LedCalc.jsx';
import FrameCalc from '../calc/FrameCalc.jsx';
import EpoxyCalc from '../calc/EpoxyCalc.jsx';
import GomuCalc from '../calc/GomuCalc.jsx';
import GoldSilverCalc from '../calc/GoldSilverCalc.jsx';
import { FillContext } from '../calc/fillContext';
import '../calc/Calc.css';
import './MiniCalc.css';

export interface FillPayload {
  code?: string;
  spec?: string;
  qty?: number;
  unit?: number | null;
}

/**
 * 명세서작성 모달 안에 띄우는 미니 단가계산기 — /admin/calc 의 계산기 카드(자급식, prices prop)를
 * 그대로 재사용해 작은 창으로. 헤더를 잡아 자유롭게 이동, ✕ 로 닫기. 각 카드에 [복사] 버튼 내장.
 *
 * 포커스 분리: 창 안의 keydown 은 stopPropagation 으로 명세서 모달의 전역 단축키(1/2 등)에
 * 닿지 않게 한다 — 계산기 입력 중에 도구가 바뀌는 사고 방지.
 */
const TABS: { key: string; label: string; C: ComponentType<{ prices: unknown }> }[] = [
  { key: 'acryl', label: '아크릴/포맥스', C: AcrylCalc as ComponentType<{ prices: unknown }> },
  { key: 'channel', label: '잔넬', C: ChannelCalc as ComponentType<{ prices: unknown }> },
  { key: 'led', label: 'LED', C: LedCalc as ComponentType<{ prices: unknown }> },
  { key: 'frame', label: '후렘', C: FrameCalc as ComponentType<{ prices: unknown }> },
  { key: 'epoxy', label: '에폭시', C: EpoxyCalc as ComponentType<{ prices: unknown }> },
  { key: 'gomu', label: '고무스카시', C: GomuCalc as ComponentType<{ prices: unknown }> },
  { key: 'gold', label: '금은경', C: GoldSilverCalc as ComponentType<{ prices: unknown }> },
];

export default function MiniCalc({
  onClose,
  onFill,
  fillRow,
  fillColor,
}: {
  onClose: () => void;
  onFill?: (p: FillPayload) => void; // 계산 결과를 명세서 빈 행에 채우기(없으면 카드는 [복사] 버튼).
  fillRow?: number; // 채울 빈 행 인덱스(0-based). 버튼에 그리드와 같은 동그라미 N 으로 표시.
  fillColor?: string; // 그 행 동그라미 색(그리드와 일치).
}) {
  const { prices } = usePrices();
  // 채우기 모드면 카드의 [복사] 버튼이 [(N) 번에 채우기] 로 바뀐다(FillContext). 일반(홈페이지)은 null.
  const canFill = typeof fillRow === 'number' && fillRow >= 0;
  const fillValue = onFill
    ? {
        onFill,
        canFill,
        num: canFill ? (fillRow as number) + 1 : null, // 동그라미에 표시할 1-based 행 번호
        color: fillColor || '#0a7d8c',
      }
    : null;
  const [tab, setTab] = useState('acryl');
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round(window.innerWidth * 0.5)),
    y: Math.round(window.innerHeight * 0.14),
  }));
  const drag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  const onHeadDown = (e: React.MouseEvent) => {
    // 헤더(또는 빈 곳)만 드래그 핸들 — 버튼/탭에서 시작한 드래그는 무시.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      const nx = drag.current.px + (ev.clientX - drag.current.sx);
      const ny = drag.current.py + (ev.clientY - drag.current.sy);
      // 헤더가 화면 밖으로 완전히 나가지 않도록 살짝 클램프.
      setPos({
        x: Math.min(Math.max(-260, nx), window.innerWidth - 60),
        y: Math.min(Math.max(0, ny), window.innerHeight - 40),
      });
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const Active = TABS.find((t) => t.key === tab)?.C;

  return (
    <div
      className="minicalc"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="minicalc-head" onMouseDown={onHeadDown}>
        <span className="minicalc-title">🧮 단가계산기</span>
        <button type="button" className="minicalc-x" onClick={onClose} title="계산기 닫기">
          ×
        </button>
      </div>
      <div className="minicalc-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'minicalc-tab' + (tab === t.key ? ' on' : '')}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <FillContext.Provider value={fillValue}>
        <div className="minicalc-body">
          {prices && Active ? <Active prices={prices} /> : <div className="minicalc-loading">단가표 로드 중…</div>}
        </div>
      </FillContext.Provider>
    </div>
  );
}
