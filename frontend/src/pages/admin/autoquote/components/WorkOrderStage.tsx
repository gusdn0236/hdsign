/**
 * 작업지시서 스테이지 — 붙여넣기/업로드된 이미지 위에 자동검출 가격 PIN 을 오버레이.
 *
 * 순수 표현 컴포넌트: 가격 산출/비전 호출은 상위(AutoQuote)가 담당하고, 여기서는
 * 이미지 + 절대배치 핀만 그린다. 낮은 신뢰도 핀은 노랑(.low)으로 표시한다.
 * 비전 스키마에 좌표가 없으므로 핀은 항목 순서대로 세로 균등 배치한다.
 */

export interface OverlayPin {
  /** 안정적 key (entry id). */
  id: number;
  /** 핀 상단 라벨 (예: "① 채널간판 · 검토요"). */
  tag: string;
  /** 포맷된 가격 문자열 (예: "₩540,000"). */
  price: string;
  /** 낮은 신뢰도 → 노랑 핀. */
  low: boolean;
}

interface Props {
  imageSrc: string;
  pins: OverlayPin[];
}

export default function WorkOrderStage({ imageSrc, pins }: Props) {
  return (
    <div className="aq-stage" data-testid="work-order-stage">
      <img
        className="aq-stage-img"
        src={imageSrc}
        alt="붙여넣은 작업지시서"
        data-testid="work-order-image"
      />
      {pins.map((p, i) => (
        <div
          key={p.id}
          className={`aq-pin${p.low ? ' low' : ''}`}
          data-testid="price-overlay"
          data-entry-id={p.id}
          // 좌표 미제공 → 항목 순서대로 세로 균등 배치, 우측 정렬.
          style={{ top: `${((i + 1) / (pins.length + 1)) * 100}%`, left: '58%' }}
        >
          <span className="aq-pin-tag">{p.tag}</span>
          <span className="aq-pin-price">{p.price}</span>
        </div>
      ))}
    </div>
  );
}
