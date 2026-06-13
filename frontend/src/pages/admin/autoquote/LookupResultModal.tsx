import { useEffect, useRef, useReducer, useState, type ReactNode } from 'react';
import type { Evidence } from './annot/api';

/**
 * 단가찾아보기 결과 한 후보(과거 명세서). 단가계산기 탭·명세서작성 양쪽이 공유한다.
 * 양쪽 모달 UI를 한 곳에서 관리하기 위해 추출 — 여기만 고치면 둘 다 바뀐다.
 */
export interface LookupRef {
  src: string; // 관련도 라벨('이력'|'타거래처'|…) — 거래처명 폴백용
  price: number;
  evidence: Evidence | null;
  date?: string; // 후보 명세서 날짜 'YYYY.MM.DD'
  cspec?: string; // 후보 규격
  est?: number | null; // 입력 사이즈 기준 예상 단가
  reason?: string;
  hitPrice?: number;
}

/** 'YYYY.MM.DD' → '2025년 12월 1일'(일 없으면 '2025년 12월', 못 읽으면 원문). */
export function ymdLabel(d?: string): string {
  if (!d) return '';
  const s = String(d);
  const md = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (md) return `${md[1]}년 ${+md[2]}월 ${+md[3]}일`;
  const m = s.match(/(\d{4})\D+(\d{1,2})/);
  return m ? `${m[1]}년 ${+m[2]}월` : s;
}

/** 문자열/숫자 → 숫자(없으면 null). 명세서 단가 셀 파싱용. */
function num(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 도장 관련 행인지(품목코드·품목 어디든 '도장' 포함). 검색결과 표에서 연한 색으로 강조. */
export function isDojangRow(g: { item_code?: string; item?: string }): boolean {
  return /도장/.test((g.item_code || '') + ' ' + (g.item || ''));
}

/** 실제 '도장비' 청구행(가격 있는 도장행, '도장없음/도장X' 제외) — 가져올 때 품목코드를 '도장비'로 통일. */
export function isDojangFeeRow(g: { item_code?: string; item?: string; unit_price?: string | number }): boolean {
  const text = (g.item_code || '') + ' ' + (g.item || '');
  if (!/도장/.test(text)) return false;
  if (/도장\s*없음|도장\s*x/i.test(text)) return false; // 명시적 '도장 안 함'은 통일 대상 아님
  return (num(g.unit_price) ?? 0) > 0;
}

/** 명세서작성에서 다중선택해 가져오는 한 행. 도장비면 규격에 짝 가공행 사이즈가 채워진다. */
export interface PickedRow {
  item_code: string;
  item: string;
  spec: string;
  qty: string;
  unit_price: string;
  isDojangFee: boolean;
  date?: string;
  client?: string;
}

/**
 * 지시서 사진 뷰어 — 마우스 휠로 커서 기준 확대·축소(1~6배), 드래그로 이동, 더블클릭 초기화.
 * 사진(src)이 바뀌면 배율·위치를 리셋한다. 모달 스크롤을 막으려 휠은 native non-passive 로 등록.
 */
function ZoomImg({ src, alt }: { src: string; alt: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const t = useRef({ scale: 1, tx: 0, ty: 0 }); // 현재 변환(휠 핸들러가 최신값을 읽도록 ref)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [, force] = useReducer((x) => x + 1, 0);
  const apply = (scale: number, tx: number, ty: number) => {
    t.current = { scale, tx, ty };
    force();
  };

  // 사진이 바뀌면 확대·이동 초기화.
  useEffect(() => {
    apply(1, 0, 0);
  }, [src]);

  // 휠 줌(커서 아래 지점 고정). React onWheel 은 passive 라 preventDefault 가 안 먹어 native 로 등록.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2; // 컨테이너 중심 기준 커서
      const cy = e.clientY - rect.top - rect.height / 2;
      const { scale, tx, ty } = t.current;
      const next = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === 1) {
        apply(1, 0, 0);
        return;
      }
      const k = next / scale;
      apply(next, cx - (cx - tx) * k, cy - (cy - ty) * k);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e: React.MouseEvent) => {
    if (t.current.scale === 1) return; // 확대 안 했으면 이동 불필요
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, tx: t.current.tx, ty: t.current.ty };
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current) return;
    apply(t.current.scale, drag.current.tx + (e.clientX - drag.current.x), drag.current.ty + (e.clientY - drag.current.y));
  };
  const onUp = () => {
    drag.current = null;
  };

  const { scale, tx, ty } = t.current;
  return (
    <div
      ref={wrapRef}
      className="lk-zoom"
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onDoubleClick={() => apply(1, 0, 0)}
      style={{ cursor: scale > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
      title="휠: 확대·축소 · 드래그: 이동 · 더블클릭: 원래대로"
    >
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }} />
    </div>
  );
}

interface Props {
  refs: LookupRef[];
  ri: number;
  lpi: number; // 현재 후보의 지시서 사진 인덱스(다장 갤러리)
  onAction: (price: number) => void;
  totalFound?: number; // 사진 있는 비슷한 명세서 총 건수("총 N건 찾았습니다"). 표시는 30건만.
  confirmBeforeAction?: boolean; // true면 행/버튼 클릭 시 "이 가격으로 결정할까요?" 한번 확인 후 적용.
  /**
   * 'single'(기본·단가계산기): 행 클릭 = 그 단가 1개 적용(onAction).
   * 'multi'(명세서작성): 행 클릭 = 선택 토글, [명세서에 추가]로 선택분 전부 가져옴(onActionMulti).
   */
  mode?: 'single' | 'multi';
  onActionMulti?: (rows: PickedRow[]) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  setLpi: (f: (i: number) => number) => void;
  extras?: ReactNode; // 헤더 아래 부가 영역(명세서작성: 품목코드 태그 바·추천 칩)
  /**
   * 작성중↔검색 토글(명세서작성 전용). onToggleView 가 있을 때만 토글 버튼이 뜬다.
   * 'working' = 지금 작성 중인 지시서(좌)·명세서(우)를 보여줌. 검색 페이지(ri/lpi)는 유지된다.
   */
  view?: 'search' | 'working';
  onToggleView?: () => void;
  toggleToWorkingLabel?: string; // 검색 보기일 때 버튼 문구
  toggleToSearchLabel?: string; // 작성중 보기일 때 버튼 문구
  workingTitle?: string; // 작성중 보기 제목
  workingLeft?: ReactNode; // 작성중 보기 — 좌측(지시서 이미지)
  workingRight?: ReactNode; // 작성중 보기 — 우측(작성 중 명세서 표)
  /**
   * 묶음(bundle) 넘기기 — 현재 후보와 같은 지시서를 공유하는 형제 명세서들. 셋째 네비 축.
   * bundleCount>1 일 때만 '묶음 k/n' 페이저가 뜬다. props 생략 시(명세서작성 재사용) 안 뜸.
   * bi=0 = 후보 본인, 1..n = 형제. bundleEvidence 가 현재 표시할 명세서(사진열·grid 둘 다 스왑).
   */
  bundleCount?: number;
  bi?: number;
  setBi?: (i: number) => void;
  bundleEvidence?: Evidence | null; // bi 에 해당하는 명세서(0이면 후보 evidence 와 동일)
  bundleLabel?: string; // 형제일 때 '형제 · 날짜 거래처' (후보면 undefined)
}

/**
 * 단가찾아보기 결과 모달 — 좌측 과거 작업지시서 사진 + 우측에 예상 가격 한 줄 + 과거 명세서 표(전체).
 * 후보는 ‹ › 또는 ← → 로 넘긴다. 표의 행을 클릭하면 그 단가가 적용/복사된다(matched 행은 강조).
 *
 * 명세서작성에서는 헤더의 토글로 '작성 중인 지시서·명세서'와 '검색된 과거 명세서'를 오간다.
 * 토글해도 보고 있던 검색 페이지(후보·사진 인덱스)는 그대로라, 새 검색 전까지 같은 자리로 돌아온다.
 */
export default function LookupResultModal({
  refs,
  ri,
  lpi,
  onAction,
  totalFound,
  confirmBeforeAction,
  mode = 'single',
  onActionMulti,
  onPrev,
  onNext,
  onClose,
  setLpi,
  extras,
  view = 'search',
  onToggleView,
  toggleToWorkingLabel = '작성중인 명세서 보기',
  toggleToSearchLabel = '검색된 과거명세서 보기',
  workingTitle = '작성중인 명세서',
  workingLeft,
  workingRight,
  bundleCount,
  bi = 0,
  setBi,
  bundleEvidence,
  bundleLabel,
}: Props) {
  const working = view === 'working';
  const multi = mode === 'multi';
  const hasBundle = !!setBi && (bundleCount ?? 0) > 1; // 형제 1+ 있을 때만 묶음 페이저

  // 다중선택(명세서작성) — 후보·묶음을 넘나들며 누적. 키=`${ri}:${bi}:${행번호}`(후보별 grid 가 달라서).
  const [picked, setPicked] = useState<Record<string, PickedRow>>({});
  const [pendingMulti, setPendingMulti] = useState(false);
  // 키(`ri:bi:행`)를 숫자로 정렬 → 후보·행 자연순서로 추가(가공행 다음 그 도장비 순).
  const pickedList = Object.entries(picked)
    .sort(([a], [b]) => {
      const pa = a.split(':').map(Number);
      const pb = b.split(':').map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    })
    .map(([, v]) => v);
  const togglePick = (key: string, row: PickedRow) => {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = row;
      return next;
    });
  };

  // 가격 적용 확인 — confirmBeforeAction 일 때 행/버튼 클릭이 바로 적용되지 않고 여기에 담긴다.
  // "이 가격으로 결정할까요?" 확인 바가 뜨고, Enter 또는 [적용] 클릭으로 onAction 호출.
  const [pending, setPending] = useState<number | null>(null);
  const ask = (price: number) => {
    if (confirmBeforeAction) setPending(price);
    else onAction(price);
  };
  // 후보를 넘기거나 보기를 토글하면 확인 대기를 취소(엉뚱한 행에 적용 방지).
  useEffect(() => {
    setPending(null);
  }, [ri, view]);

  // 키보드 ← → 후보 넘기기, Esc 닫기 (입력칸 포커스 중이면 무시). 작성중 보기에선 후보 넘기기 끔.
  // 확인 대기 중이면: Enter=적용, Esc=취소(모달은 안 닫음), ←→는 무시.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (pending != null) {
        if (e.key === 'Enter') {
          e.preventDefault();
          onAction(pending);
          setPending(null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setPending(null);
        }
        return;
      }
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (working) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext, onClose, working, pending, onAction]);

  const R = refs[ri];
  // 묶음 형제를 보는 중이면 그 명세서로 스왑(사진열·grid 둘 다). 후보(bi=0)면 R.evidence 와 동일.
  const ev = bundleEvidence !== undefined ? bundleEvidence : R?.evidence;
  const onSibling = !!bundleLabel; // 형제 표시 중(예상가·복사 버튼은 후보에서만)
  // 다장(many-to-many) 지원: ev.photos 있으면 그걸, 없으면 단일 photo_base64 폴백.
  const phs =
    ev?.photos && ev.photos.length
      ? ev.photos
      : ev?.photo_base64
        ? [{ content_type: ev.photo_content_type || 'image/jpeg', base64: ev.photo_base64 }]
        : [];
  const cur = phs.length ? phs[Math.min(lpi, phs.length - 1)] : null;
  const photo = cur ? `data:${cur.content_type || 'image/jpeg'};base64,${cur.base64}` : null;

  // 제목 = 근거 명세서의 거래처명만(예: '나라광고(안양)'). 발행일은 본문 규격·단가 위에 따로 표시.
  const corp = ev?.client || R?.src || '거래처';
  const dateStr = ymdLabel(ev?.date || R?.date);
  const title = R ? corp : '단가 찾아보기';
  const grid = ev?.grid || [];

  return (
    <div className="aq-modal on lk-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="aq-mbox">
        <div className="aq-mhead">
          <b className="lk-title">{working ? workingTitle : title}</b>
          {onToggleView && (
            <button type="button" className="lk-toggle" onClick={onToggleView}>
              {working ? toggleToSearchLabel : toggleToWorkingLabel}
            </button>
          )}
          {/* 네비는 양쪽 보기에서 항상 같은 자리·같은 폭으로 렌더 → 토글 버튼이 흔들리지 않음. */}
          <span className="aq-nav">
            <button onClick={onPrev} disabled={working}>
              ‹
            </button>
            <span style={{ fontSize: 12.5, color: '#6b7785' }}>{refs.length ? `${ri + 1} / ${refs.length}` : '0'}</span>
            <button onClick={onNext} disabled={working}>
              ›
            </button>
            <button className="aq-x" onClick={onClose}>
              ×
            </button>
          </span>
        </div>
        {!working && typeof totalFound === 'number' && (
          <div className="lk-foundcnt">
            비슷한 명세서를 총 <b>{totalFound}</b>건 찾았습니다.
            {totalFound > refs.length ? ` (최신 ${refs.length}건 표시)` : ''}
          </div>
        )}
        {!working && extras}
        {working ? (
          <div className="aq-mbody">
            <div className="aq-mleft" style={{ position: 'relative' }}>{workingLeft}</div>
            <div className="aq-mright lk-working">{workingRight}</div>
          </div>
        ) : !refs.length || !R ? (
          <div className="aq-mbody">
            <div className="aq-mleft">
              <div className="none">
                {multi
                  ? '위 검색창에 품목코드를 입력하고 Enter 를 누르면 과거 명세서를 찾아줍니다.'
                  : '관련 과거 단가가 없습니다. 품목코드/규격을 확인해 보세요.'}
              </div>
            </div>
            <div className="aq-mright" />
          </div>
        ) : (
          <>
          <div className="aq-mbody">
            <div className="aq-mleft" style={{ position: 'relative' }}>
              {photo ? (
                <ZoomImg src={photo} alt="과거 작업지시서" />
              ) : (
                <div className="none">{ev == null && !onSibling ? '사진 불러오는 중…' : '사진 없음'}</div>
              )}
              {phs.length > 1 && (
                <div className="lk-gal">
                  <button onClick={() => setLpi((i) => (i > 0 ? i - 1 : phs.length - 1))}>‹</button>
                  <span>
                    지시서 {Math.min(lpi, phs.length - 1) + 1} / {phs.length}
                  </span>
                  <button onClick={() => setLpi((i) => (i < phs.length - 1 ? i + 1 : 0))}>›</button>
                </div>
              )}
            </div>
            <div className="aq-mright lk-right">
              {dateStr ? <div className="lk-date">{dateStr} 명세서</div> : null}
              {/* 예상가·단독 버튼 대신 "표에서 직접 골라라" 안내 — 명세서작성·단가계산기 공통. */}
              <div className="lk-pick">
                {multi
                  ? '가져올 행을 클릭해 선택하세요. 도장 행은 노란색입니다. (여러 개 가능)'
                  : '명세서에서 적용하실 가격을 선택해주세요.'}
              </div>
              {grid.length ? (
                <table className="aq-rtbl lk-tbl">
                  <thead>
                    <tr>
                      <th>품목코드</th>
                      <th>품목</th>
                      <th>규격</th>
                      <th>수량</th>
                      <th className="p">단가</th>
                      <th className="p">공급가액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.map((g, j) => {
                      const price = num(g.unit_price);
                      const q = num(g.qty) ?? 1;
                      const supply = price != null ? price * q : null; // 공급가액 = 단가 × 수량
                      const hit = price != null && price === Math.round(Number(R.price));
                      const clk = price != null && price > 0;
                      const dj = isDojangRow(g);
                      const feeRow = isDojangFeeRow(g);
                      // 도장비 행이면 규격에 채울 '짝 가공행 사이즈' = 바로 위쪽 비(非)도장 행 중 규격 있는 첫 행.
                      let pairedSpec = '';
                      if (feeRow) {
                        for (let k = j - 1; k >= 0; k--) {
                          if (!isDojangRow(grid[k]) && (grid[k].spec || '').trim()) {
                            pairedSpec = grid[k].spec || '';
                            break;
                          }
                        }
                      }
                      const key = `${ri}:${bi}:${j}`;
                      const sel = multi && !!picked[key];
                      const onRow = !clk
                        ? undefined
                        : multi
                          ? () =>
                              togglePick(key, {
                                item_code: g.item_code || '',
                                item: g.item || '',
                                spec: (feeRow ? pairedSpec || g.spec : g.spec) || '',
                                qty: String(g.qty ?? ''),
                                unit_price: String(g.unit_price ?? ''),
                                isDojangFee: feeRow,
                                date: ev?.date,
                                client: ev?.client,
                              })
                          : () => ask(price as number);
                      return (
                        <tr
                          key={j}
                          className={
                            (hit ? 'hit ' : '') + (clk ? 'click ' : '') + (dj ? 'dojang ' : '') + (sel ? 'picked' : '')
                          }
                          onClick={onRow}
                        >
                          <td>
                            {multi && clk ? <span className="lk-chk">{sel ? '☑' : '☐'}</span> : null}
                            {g.item_code || ''}
                          </td>
                          <td>{g.item || ''}</td>
                          <td>{g.spec || ''}</td>
                          <td>{g.qty ?? ''}</td>
                          <td className="p">{price != null ? price.toLocaleString() : (g.unit_price ?? '')}</td>
                          <td className="p">{supply != null ? supply.toLocaleString() : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
          {hasBundle && (
            <div className="lk-bundle">
              <button onClick={() => setBi!(bi > 0 ? bi - 1 : bundleCount! - 1)} aria-label="이전 묶음">
                ‹
              </button>
              <span className="lk-bundle-cnt">
                묶음 {bi + 1} / {bundleCount}
              </span>
              <button onClick={() => setBi!(bi < bundleCount! - 1 ? bi + 1 : 0)} aria-label="다음 묶음">
                ›
              </button>
              <span className="lk-bundle-lbl">{bundleLabel || '이 후보(기준 명세서)'}</span>
            </div>
          )}
          {multi && (
            <div className="lk-multibar">
              <span className="lk-multi-cnt">
                선택 <b>{pickedList.length}</b>건
                {pickedList.some((r) => r.isDojangFee) ? ' · 도장비는 품목코드 "도장비"로 추가됩니다' : ''}
              </span>
              <span className="lk-multi-btns">
                {pickedList.length > 0 && (
                  <button type="button" className="lk-multi-clear" onClick={() => setPicked({})}>
                    선택 해제
                  </button>
                )}
                <button
                  type="button"
                  className="lk-multi-ok"
                  disabled={pickedList.length === 0}
                  onClick={() => setPendingMulti(true)}
                >
                  명세서에 추가 ({pickedList.length})
                </button>
              </span>
            </div>
          )}
          </>
        )}
        {pending != null && (
          <div className="lk-confirm" onClick={(e) => e.target === e.currentTarget && setPending(null)}>
            <div className="lk-confirm-box">
              <div className="lk-confirm-q">
                이 가격 <b>{pending.toLocaleString()}원</b> 으로 결정할까요?
              </div>
              <div className="lk-confirm-btns">
                <button
                  className="lk-confirm-ok"
                  onClick={() => {
                    onAction(pending);
                    setPending(null);
                  }}
                >
                  적용 (Enter)
                </button>
                <button className="lk-confirm-cancel" onClick={() => setPending(null)}>
                  취소
                </button>
              </div>
            </div>
          </div>
        )}
        {pendingMulti && (
          <div className="lk-confirm" onClick={(e) => e.target === e.currentTarget && setPendingMulti(false)}>
            <div className="lk-confirm-box">
              <div className="lk-confirm-q">
                선택한 <b>{pickedList.length}개 행</b>을 작성 중인 명세서에 추가할까요?
              </div>
              <div className="lk-confirm-btns">
                <button
                  className="lk-confirm-ok"
                  onClick={() => {
                    onActionMulti?.(pickedList);
                    setPendingMulti(false);
                    setPicked({});
                  }}
                >
                  추가
                </button>
                <button className="lk-confirm-cancel" onClick={() => setPendingMulti(false)}>
                  취소
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
