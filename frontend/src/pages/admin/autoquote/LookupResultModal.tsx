import { useEffect, type ReactNode } from 'react';
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

/** 500원 단위 반올림(예상 가격 안내용). */
function round500(n: number): number {
  return Math.round(n / 500) * 500;
}

/** 문자열/숫자 → 숫자(없으면 null). 명세서 단가 셀 파싱용. */
function num(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

interface Props {
  refs: LookupRef[];
  ri: number;
  lpi: number; // 현재 후보의 지시서 사진 인덱스(다장 갤러리)
  userSpec: string; // 사용자가 입력한 규격(예상 가격 안내문에 표시)
  actionLabel: string; // 기본 버튼 라벨(복사/적용)
  onAction: (price: number) => void;
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
  userSpec,
  actionLabel,
  onAction,
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
}: Props) {
  const working = view === 'working';

  // 키보드 ← → 후보 넘기기, Esc 닫기 (입력칸 포커스 중이면 무시). 작성중 보기에선 후보 넘기기 끔.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
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
  }, [onPrev, onNext, onClose, working]);

  const R = refs[ri];
  const ev = R?.evidence;
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
  const dateStr = ymdLabel(R?.date || ev?.date);
  const title = R ? corp : '단가 찾아보기';
  const est = R?.est != null ? round500(R.est) : null;
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
        {!working && extras}
        {working ? (
          <div className="aq-mbody">
            <div className="aq-mleft" style={{ position: 'relative' }}>{workingLeft}</div>
            <div className="aq-mright lk-working">{workingRight}</div>
          </div>
        ) : !refs.length || !R ? (
          <div className="aq-mbody">
            <div className="aq-mleft">
              <div className="none">관련 과거 단가가 없습니다. 품목코드/규격을 확인해 보세요.</div>
            </div>
            <div className="aq-mright" />
          </div>
        ) : (
          <div className="aq-mbody">
            <div className="aq-mleft" style={{ position: 'relative' }}>
              {photo ? <img src={photo} alt="과거 작업지시서" /> : <div className="none">사진 없음</div>}
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
              {est != null && userSpec ? (
                <div className="lk-est">
                  현재 입력하신 <b>{userSpec}</b> 사이즈의 예상 가격은 <b>{est.toLocaleString()}원</b> 입니다.
                </div>
              ) : null}
              <button className="aq-btn sh lk-action" onClick={() => onAction(R.price)}>
                {actionLabel}
              </button>
              {grid.length ? (
                <table className="aq-rtbl lk-tbl">
                  <thead>
                    <tr>
                      <th>품목코드</th>
                      <th>품목</th>
                      <th>규격</th>
                      <th>수량</th>
                      <th className="p">단가</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.map((g, j) => {
                      const price = num(g.unit_price);
                      const hit = price != null && price === Math.round(Number(R.price));
                      const clk = price != null && price > 0;
                      return (
                        <tr
                          key={j}
                          className={(hit ? 'hit ' : '') + (clk ? 'click' : '')}
                          onClick={clk ? () => onAction(price as number) : undefined}
                        >
                          <td>{g.item_code || ''}</td>
                          <td>{g.item || ''}</td>
                          <td>{g.spec || ''}</td>
                          <td>{g.qty ?? ''}</td>
                          <td className="p">{price != null ? price.toLocaleString() : (g.unit_price ?? '')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
