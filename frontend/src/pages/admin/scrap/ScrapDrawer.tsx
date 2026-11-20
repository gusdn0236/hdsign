import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ScrapViewer from './ScrapViewer';
import { loadPanelWidth, savePanelWidth, scrap, useScrap, type ScrapItem } from './scrapStore';
import './Scrap.css';

/**
 * 관리자 화면 왼쪽에 늘 떠 있는 스크랩 서랍. 카드를 누르면 바로 옆에 참고 창(지시서+명세서)이 뜬다.
 * 서랍 폭은 CSS 변수 --scrap-w 로 내보내 — 관리자 화면·명세서작성 같은 전체화면 창이 그만큼 비켜 선다.
 */
const W_OPEN = 220;
const W_CLOSED = 34;

const won = (v?: string) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return String(v ?? '').trim() && Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}원` : '';
};
const shortDate = (d: string) => {
  const m = String(d || '').match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1].slice(-2)}.${m[2].padStart(2, '0')}.${m[3].padStart(2, '0')}` : d;
};

function Card({
  it,
  i,
  on,
  dragFrom,
}: {
  it: ScrapItem;
  i: number;
  on: boolean;
  dragFrom: React.MutableRefObject<number | null>;
}) {
  const r = it.rows[0];
  const [over, setOver] = useState(false);
  return (
    <div
      className={`scr-card ${on ? 'is-on' : ''} ${over ? 'is-over' : ''}`}
      draggable
      onDragStart={(e) => {
        dragFrom.current = i;
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (dragFrom.current == null) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (dragFrom.current != null) scrap.move(dragFrom.current, i);
        dragFrom.current = null;
      }}
      onDragEnd={() => {
        dragFrom.current = null;
        setOver(false);
      }}
      onClick={() => scrap.open(it.key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && scrap.open(it.key)}
    >
      <div className="scr-thumb">
        {it.thumb ? <img src={it.thumb} alt="" draggable={false} loading="lazy" /> : <span>📄</span>}
        <em className={`scr-kind scr-kind--${it.kind}`}>{it.kind === 'home' ? '홈페이지' : '이지폼'}</em>
      </div>
      <div className="scr-info">
        <b>{it.client || '거래처 없음'}</b>
        <span className="scr-date">{shortDate(it.date)}</span>
        {r && (
          <span className="scr-row" title={[r.품목코드, r.품목, r.규격].filter(Boolean).join(' · ')}>
            {r.품목 || r.품목코드} {r.규격}
            {won(r.단가) && <i>{won(r.단가)}</i>}
          </span>
        )}
      </div>
      <button
        type="button"
        className="scr-del"
        aria-label="스크랩 빼기"
        title="빼기"
        onClick={(e) => {
          e.stopPropagation();
          scrap.remove(it.key);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function Panel({ it, token }: { it: ScrapItem; token: string | null | undefined }) {
  const [w, setW] = useState(loadPanelWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      scrap.open(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, w };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setW(Math.max(320, Math.min(window.innerWidth - 260, drag.current.w + e.clientX - drag.current.x)));
  };
  const onUp = () => {
    if (drag.current) savePanelWidth(w);
    drag.current = null;
  };
  return (
    <div className="scr-panel" style={{ width: w }} role="dialog" aria-label="스크랩 참고">
      <div className="scr-panel-head">
        <b>{it.client || '거래처 없음'}</b>
        <span>
          {shortDate(it.date)}
          {it.orderNumber ? ` · ${it.orderNumber}` : ''}
        </span>
        <button type="button" className="scr-panel-x" onClick={() => scrap.open(null)} aria-label="닫기">
          ✕
        </button>
      </div>
      <ScrapViewer token={token} item={it} />
      <div className="scr-panel-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} title="끌어서 폭 조절">
        {/* 세로 가운데 손잡이 — 끌 수 있는 곳임을 보이게(회색 ‖) */}
        <span className="scr-panel-handle" aria-hidden="true" />
      </div>
    </div>
  );
}

export default function ScrapDrawer({ token }: { token: string | null | undefined }) {
  const { items, openKey, collapsed } = useScrap();
  const dragFrom = useRef<number | null>(null);
  const [askClear, setAskClear] = useState(false);
  const opened = items.find((x) => x.key === openKey) || null;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--scrap-w', `${collapsed ? W_CLOSED : W_OPEN}px`);
    root.classList.add('has-scrap');
    return () => {
      root.style.removeProperty('--scrap-w');
      root.classList.remove('has-scrap');
    };
  }, [collapsed]);

  if (collapsed) {
    return (
      <aside className="scr is-closed">
        <button type="button" className="scr-open" onClick={() => scrap.setCollapsed(false)} title="스크랩 펼치기">
          <span>»</span>
          <span className="scr-vert">📌 스크랩</span>
          {items.length > 0 && <b>{items.length}</b>}
        </button>
      </aside>
    );
  }

  return (
    <>
      <aside className="scr">
        <div className="scr-head">
          <span className="scr-title">
            📌 스크랩 {items.length > 0 && <b>{items.length}</b>}
          </span>
        </div>
        {/* 접기 — 접었을 때 여는 손잡이와 같은 높이(화면 40%)에, 서랍 오른쪽 가장자리 바깥으로 */}
        <button type="button" className="scr-fold-tab" onClick={() => scrap.setCollapsed(true)} title="스크랩 접기">
          «
        </button>
        <div className="scr-list">
          {items.length === 0 ? (
            <div className="scr-none">비어 있어요</div>
          ) : (
            items.map((it, i) => <Card key={it.key} it={it} i={i} on={it.key === openKey} dragFrom={dragFrom} />)
          )}
        </div>
        {items.length > 0 && (
          <div className="scr-foot">
            {askClear ? (
              <>
                <button
                  type="button"
                  className="scr-clear is-danger"
                  onClick={() => {
                    scrap.clear();
                    setAskClear(false);
                  }}
                >
                  전부 빼기
                </button>
                <button type="button" className="scr-clear" onClick={() => setAskClear(false)}>
                  취소
                </button>
              </>
            ) : (
              <button type="button" className="scr-clear" onClick={() => setAskClear(true)}>
                비우기
              </button>
            )}
          </div>
        )}
      </aside>
      {opened && <Panel key={opened.key} it={opened} token={token} />}
    </>
  );
}

/** 결과 카드에 붙이는 📌 담기 버튼 — 담겨 있으면 채워진 모양, 누르면 빼기. */
export function ScrapPin({
  item,
  className = '',
  label = false,
  onAdd,
}: {
  item: Omit<ScrapItem, 'addedAt'>;
  className?: string;
  label?: boolean;
  onAdd?: () => void; // 담을 때(작은 사진 만들기 등)
}) {
  const { items } = useScrap();
  const on = items.some((x) => x.key === item.key);
  return (
    <button
      type="button"
      className={`scr-pin ${on ? 'is-on' : ''} ${className}`}
      title={on ? '스크랩에서 빼기' : '스크랩에 담기'}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        scrap.toggle(item);
        if (!on) onAdd?.();
      }}
    >
      📌{label ? (on ? ' 담음' : ' 담기') : ''}
    </button>
  );
}
