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

const PANEL_MIN = 320;
const SLIDE_MID = (W_OPEN + W_CLOSED) / 2; // 손을 놓을 때 서랍이 이만큼보다 덜 보이면 접힘, 더 보이면 펼침

/** 참고 창. 손잡이를 끌면 폭 조절 — 최소 폭보다 더 왼쪽으로 밀면 스크랩 서랍이 같이 화면 밖으로 밀려나고,
 *  접힌 상태에서 화면 절반 너머로 끌어 오면 서랍이 따라 들어온다. 손을 놓을 때 서랍이 절반 넘게 보이면 펼침,
 *  아니면 접힘(사용자 요청 2026-11-20). dw = 지금 서랍이 보이는 폭. */
function Panel({
  it,
  token,
  collapsed,
  dw,
  onSlide,
  onRelease,
}: {
  it: ScrapItem;
  token: string | null | undefined;
  collapsed: boolean;
  dw: number;
  onSlide: (dw: number | null) => void;
  onRelease: (dw: number) => void;
}) {
  const [w, setW] = useState(loadPanelWidth);
  const drag = useRef<{ x: number; r: number; dw: number; w: number } | null>(null);
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
    drag.current = { x: e.clientX, r: dw + w, dw, w };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const maxW = window.innerWidth - 260;
    const r = d.r + e.clientX - d.x; // 참고 창 오른쪽 끝 = 손잡이 위치
    let nd: number;
    let nw: number;
    if (!collapsed) {
      // 펼친 상태: 최소 폭까지는 폭만, 그보다 왼쪽이면 서랍이 같이 밀려남(0 = 완전히 화면 밖).
      if (r - W_OPEN >= PANEL_MIN) {
        nd = W_OPEN;
        nw = Math.min(maxW, r - W_OPEN);
      } else {
        nw = PANEL_MIN;
        nd = Math.max(0, r - PANEL_MIN);
      }
    } else {
      // 접힌 상태: 화면 절반까지는 폭만, 그 너머로 끌면 서랍이 따라 들어옴.
      const t = window.innerWidth / 2;
      if (r <= t) {
        nd = W_CLOSED;
        nw = Math.max(PANEL_MIN, r - W_CLOSED);
      } else {
        nd = Math.min(W_OPEN, W_CLOSED + (r - t));
        nw = Math.min(maxW, Math.max(PANEL_MIN, r - nd));
      }
    }
    d.dw = nd;
    d.w = nw;
    setW(nw);
    onSlide(nd === (collapsed ? W_CLOSED : W_OPEN) ? null : nd);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    savePanelWidth(d.w);
    onRelease(d.dw);
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
      {/* 폭 조절은 세로 가운데 손잡이로만(가장자리 선은 안 잡힘 — 사용자 결정 2026-11-20) */}
      <div className="scr-panel-grip">
        <span
          className="scr-panel-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="끌어서 폭 조절"
          title="끌어서 폭 조절"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
    </div>
  );
}

export default function ScrapDrawer({ token }: { token: string | null | undefined }) {
  const { items, openKey, collapsed } = useScrap();
  const dragFrom = useRef<number | null>(null);
  const [askClear, setAskClear] = useState(false);
  const opened = items.find((x) => x.key === openKey) || null;
  // 손잡이로 끄는 중(또는 손 놓은 뒤 스르륵 움직이는 중) 서랍이 보이는 폭. null = 평소(접힘/펼침 그대로).
  const [slide, setSlide] = useState<number | null>(null);
  const animT = useRef<number | undefined>(undefined);
  const dw = slide ?? (collapsed ? W_CLOSED : W_OPEN);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--scrap-w', `${dw}px`);
    root.classList.add('has-scrap');
  }, [dw]);
  useEffect(
    () => () => {
      const root = document.documentElement;
      root.style.removeProperty('--scrap-w');
      root.classList.remove('has-scrap', 'scrap-anim');
      window.clearTimeout(animT.current);
    },
    [],
  );

  /** 손을 놓으면 절반 기준으로 접힘/펼침 쪽으로 스르륵. */
  const release = (at: number) => {
    const open = at >= SLIDE_MID;
    if (at === (collapsed ? W_CLOSED : W_OPEN) && open === !collapsed) {
      setSlide(null);
      return;
    }
    const root = document.documentElement;
    root.classList.add('scrap-anim');
    setSlide(open ? W_OPEN : W_CLOSED);
    window.clearTimeout(animT.current);
    animT.current = window.setTimeout(() => {
      scrap.setCollapsed(!open);
      setSlide(null);
      window.setTimeout(() => root.classList.remove('scrap-anim'), 30);
    }, 220);
  };
  const panel = opened && (
    <Panel key={opened.key} it={opened} token={token} collapsed={collapsed} dw={dw} onSlide={setSlide} onRelease={release} />
  );

  if (collapsed && slide === null) {
    // 서랍을 접어도 펼쳐 둔 참고 창은 그대로 — ✕ 로 닫을 때만 닫힘(사용자 결정 2026-11-20).
    // 참고 창은 --scrap-w(접힘 34px) 바로 옆에 붙으므로 접으면 왼쪽 공간이 그만큼 넓어진다.
    return (
      <>
        <aside className="scr is-closed">
          <button type="button" className="scr-open" onClick={() => scrap.setCollapsed(false)} title="스크랩 펼치기">
            <span>»</span>
            <span className="scr-vert">📌 스크랩</span>
            {items.length > 0 && <b>{items.length}</b>}
          </button>
        </aside>
        {panel}
      </>
    );
  }

  return (
    <>
      <aside
        className={'scr' + (slide !== null ? ' is-sliding' : '')}
        style={slide !== null ? { width: W_OPEN, transform: `translateX(${slide - W_OPEN}px)` } : undefined}
      >
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
      {panel}
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
