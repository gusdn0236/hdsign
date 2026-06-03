import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { pdfjs } from 'react-pdf';
// @ts-expect-error - Vite ?url 자산 임포트(타입 선언 없음). 앱 다른 곳(PdfViewer)과 동일 패턴.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
// AuthContext 는 .jsx — 확장자 명시로 vite/vitest 모두 해석되게.
import { useAuth } from '../../../context/AuthContext.jsx';
import {
  CALC,
  FIELDS,
  num,
  sizev,
  parseCode,
  computeAcryl,
  computeGomu,
} from './annot/calc';
import {
  predict,
  evidence as fetchEvidence,
  getOrder,
  getEstimate,
  putEstimate,
  type Evidence,
  type OrderContext,
} from './annot/api';
import './AutoQuote.css';

// 지시서 PDF 를 pdf.js 로 1페이지만 고해상 렌더 → JPEG dataURL. 저해상 썸네일보다 화질이 좋고,
// 데이터가 fetch(ArrayBuffer) 라 캔버스가 taint 되지 않아 [공유하기] 합성도 막히지 않는다.
// (모바일 WorksheetViewer 가 같은 R2 PDF 를 react-pdf 로 로드하므로 CORS 는 이미 허용됨.)
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
async function renderPdfFirstPage(url: string): Promise<string> {
  const pdf = await pdfjs.getDocument(url).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1, 1600 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.92);
  } finally {
    pdf.cleanup?.();
  }
}

/**
 * HD사인 자동견적 — slice-13: 주석입력(annotation) 흐름.
 *
 * 바탕화면 프로토타입(build_annot_prototype.py)의 최종 UX 를 hdsign 앱 라우트로 포팅.
 *  - 작업지시서 사진 붙여넣기(Ctrl+V) 또는 ?order=ID 진입 시 지시서 이미지 자동 로드.
 *  - 사진 위 클릭=제자리 말풍선 / 드래그=리더선+여백 말풍선. 단계입력(품목코드→품목→규격→수량→단가).
 *  - 우측 이지폼 grid(월일 자동·공급가=단가·세액10%). 핀 번호=grid 행.
 *  - 단가 [🔎 찾아보기] = slice-11 /predict + /evidence(과거 사진+명세서, JWT).
 *  - 단가 [🧮 계산기] = prices.json(acryl/gomu) 글자높이밴드 엔진.
 *  - [공유하기] = Canvas 합성→클립보드. [저장] = slice-12 estimate API.
 *
 * 기밀(예측/근거 명세서·사진)은 번들 금지 — 전부 admin JWT 로 런타임 fetch.
 */

interface Pin {
  ax: number;
  ay: number;
  lx: number;
  ly: number;
  dragged: boolean;
  vals: Record<string, string>;
  fi: number; // 입력 단계 인덱스(품목코드=0 … 단가=4). 입력 진행에만 사용; 라벨은 채워진 값 전체 표시.
  splitPending?: boolean;
}

interface DialogButton {
  label: string;
  sec?: boolean;
  fn?: () => void;
}
interface DialogState {
  html: string;
  buttons: DialogButton[];
}

interface LookupRef {
  reason: string;
  src: string;
  price: number;
  evidence: Evidence | null;
  hitPrice: number;
}

const ROWS = 10;

// 핀 색상 — 은은하고 보기 편한 중채도 팔레트. 핀 순서대로 순환(점·리더선·말풍선 동일색).
const PIN_COLORS = ['#0a7d8c', '#4f8a5b', '#b07d3a', '#8a5a7d', '#c06a52', '#5a73a8', '#6b8e4e', '#4a8c8c'];
function pinColor(i: number): string {
  return PIN_COLORS[i % PIN_COLORS.length];
}

// 단가 입력용 — 숫자만 남기고 천 단위 콤마(돈 입력처럼). 빈 값은 ''.
function formatWon(s: string): string {
  const d = String(s ?? '').replace(/[^0-9]/g, '');
  return d ? Number(d).toLocaleString() : '';
}

// 칩 한 칸 표시값: 수량→"N개", 단가→"15,000원", 그 외 원문.
function formatChip(f: string, v: string): string {
  if (f === '수량') return v + '개';
  if (f === '단가') {
    const n = num(v);
    return (n != null ? n.toLocaleString() : v) + '원';
  }
  return v;
}
// 공유 이미지용 한 줄 라벨 — 채워진 필드만 " / " 로 join.
function pinLabel(p: Pin): string {
  return FIELDS.map((f) => {
    const v = p.vals[f];
    return v ? formatChip(f, v) : null;
  })
    .filter(Boolean)
    .join(' / ');
}

function todayMD(): string {
  const d = new Date();
  return ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2);
}

interface AutoQuoteProps {
  /** 모달 모드: 부모(주문 상세)가 주문 id 를 직접 주입. 없으면 ?order= 쿼리에서 읽음. */
  orderId?: number;
  /** 모달 닫기(상단 ✕). 주어지면 닫기 버튼 노출. */
  onClose?: () => void;
  /** 저장 성공 시 호출 — 부모가 주문 목록의 명세서 배지를 즉시 갱신. */
  onSaved?: () => void;
}

export default function AutoQuote({ orderId: orderIdProp, onClose, onSaved }: AutoQuoteProps = {}) {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();

  const [pins, setPins] = useState<Pin[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [selPin, setSelPin] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [stageW, setStageW] = useState(0); // 표시 이미지 폭 — 말풍선이 우측 경계 넘치면 왼쪽으로 뒤집기 위함.
  const [order, setOrder] = useState<OrderContext | null>(null);
  const [status, setStatus] = useState('작업지시서 사진을 붙여넣으세요 (Ctrl+V)');
  const [saving, setSaving] = useState(false);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [lookup, setLookup] = useState<{ refs: LookupRef[]; ri: number; q: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // window 마우스 핸들러가 최신 상태를 읽도록 ref 미러.
  const pinsRef = useRef(pins);
  const activeRef = useRef(active);
  const selPinRef = useRef(selPin);
  const draftRef = useRef(draft);
  pinsRef.current = pins;
  activeRef.current = active;
  selPinRef.current = selPin;
  draftRef.current = draft;

  // 전역(stage 밖) 드래그 상태 — 렌더와 무관한 transient.
  const drag = useRef<{ ax: number; ay: number; moved: boolean } | null>(null);
  const pinDrag = useRef<
    { i: number; mx: number; my: number; ax: number; ay: number; lx: number; ly: number; moved: boolean } | null
  >(null);
  // 말풍선(텍스트박스) 자체를 잡아서 이동 — 태그를 핸들로. 점(앵커)은 고정, 말풍선 위치(lx,ly)만 이동.
  const bubbleDrag = useRef<{ i: number; mx: number; my: number; lx: number; ly: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; ax: number; ay: number } | null>(null);

  const cdlg = useCallback((html: string, buttons: DialogButton[]) => setDialog({ html, buttons }), []);

  // ---- ?order=ID 진입 시 지시서 이미지 + 저장된 명세서 자동 로드 -----------
  useEffect(() => {
    const id = orderIdProp ?? Number(searchParams.get('order'));
    if (!Number.isFinite(id) || id <= 0) return;
    let alive = true;
    (async () => {
      try {
        const o = await getOrder(token, id);
        if (!alive || !o) return;
        setOrder(o);
        const label = `${o.clientCompanyName || ''} · ${o.title || o.orderNumber}`;
        if (o.worksheetPdfUrl) {
          // 화질 우선: 업로드 PDF 1페이지를 고해상 렌더. 실패(CORS 등) 시 썸네일 폴백.
          setStatus(`${label} — 지시서 PDF 고해상 변환 중…`);
          try {
            const dataUrl = await renderPdfFirstPage(o.worksheetPdfUrl);
            if (alive) {
              setImgSrc(dataUrl);
              setStatus(`${label} — 지시서 로드됨`);
            }
          } catch (err) {
            console.error('PDF 렌더 실패 — 썸네일 폴백', err);
            if (alive && o.worksheetThumbnailUrl) {
              setImgSrc(o.worksheetThumbnailUrl);
              setStatus(`${label} — 지시서 로드됨(썸네일)`);
            } else if (alive) {
              setStatus(`${label} — 지시서 이미지를 붙여넣으세요`);
            }
          }
        } else if (o.worksheetThumbnailUrl) {
          setImgSrc(o.worksheetThumbnailUrl);
          setStatus(`${label} — 지시서 로드됨`);
        } else {
          setStatus(`${label} — 지시서 이미지를 붙여넣으세요`);
        }
        // 기존 명세서가 있으면 grid 를 핀(앵커 없는 grid 행)으로 복원.
        const est = await getEstimate(token, id);
        if (alive && est?.estimate?.grid?.length) {
          const restored: Pin[] = est.estimate.grid.map((g: Record<string, string>, i: number) => ({
            ax: 30,
            ay: 30 + i * 30,
            lx: 30,
            ly: 30 + i * 30,
            dragged: false,
            fi: FIELDS.length,
            vals: {
              월일: g['월일'] || '',
              품목코드: g['품목코드'] || '',
              품목: g['품목'] || '',
              규격: g['규격'] || '',
              수량: g['수량'] || '',
              단가: g['단가'] || '',
            },
          }));
          setPins(restored);
        }
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderIdProp, searchParams, token]);

  // ---- 붙여넣기 ---------------------------------------------------------
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.items || [])];
      const it = items.find((i) => i.type.startsWith('image'));
      if (!it) return;
      const file = it.getAsFile();
      if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        setImgSrc(String(r.result));
        setPins([]);
        setActive(null);
        setSelPin(null);
        setStatus('클릭=제자리 말풍선 · 드래그=리더선');
      };
      r.readAsDataURL(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // ---- 전역 마우스 무브/업 (스테이지 드래그 + 핀 드래그) ------------------
  useEffect(() => {
    const localXY = (e: MouseEvent) => {
      const st = stageRef.current?.getBoundingClientRect();
      return { x: e.clientX - (st?.left ?? 0), y: e.clientY - (st?.top ?? 0) };
    };
    const onMove = (e: MouseEvent) => {
      if (drag.current) {
        const { x, y } = localXY(e);
        if (Math.abs(x - drag.current.ax) > 4 || Math.abs(y - drag.current.ay) > 4) drag.current.moved = true;
        if (drag.current.moved) setGhost({ x, y, ax: drag.current.ax, ay: drag.current.ay });
        else setGhost(null);
      } else if (pinDrag.current) {
        const dx = e.clientX - pinDrag.current.mx;
        const dy = e.clientY - pinDrag.current.my;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pinDrag.current.moved = true;
        const pd = pinDrag.current;
        setPins((prev) =>
          prev.map((p, i) => {
            if (i !== pd.i) return p;
            const np = { ...p, ax: pd.ax + dx, ay: pd.ay + dy };
            if (!p.dragged) {
              np.lx = pd.lx + dx;
              np.ly = pd.ly + dy;
            }
            return np;
          }),
        );
      } else if (bubbleDrag.current) {
        const bd = bubbleDrag.current;
        const dx = e.clientX - bd.mx;
        const dy = e.clientY - bd.my;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) bd.moved = true;
        setPins((prev) =>
          prev.map((p, idx) => {
            if (idx !== bd.i) return p;
            // 말풍선만 이동(점 고정). 제자리 말풍선을 끌면 리더선 핀으로 전환.
            return { ...p, lx: bd.lx + dx, ly: bd.ly + dy, dragged: bd.moved ? true : p.dragged };
          }),
        );
      }
    };
    const onUp = (e: MouseEvent) => {
      if (drag.current) {
        const { x, y } = localXY(e);
        const dr = drag.current.moved;
        const ax = drag.current.ax;
        const ay = drag.current.ay;
        const lx = dr ? x : ax;
        const ly = dr ? y : ay;
        setGhost(null);
        drag.current = null;
        setSelPin(null);
        // 생성 즉시 입력칸 열기(품목코드부터). 이후 말풍선 더블클릭으로 다시 편집 가능.
        setPins((prev) => {
          const next = [...prev, { ax, ay, lx, ly, dragged: dr, vals: {}, fi: 0 }];
          setActive(next.length - 1);
          return next;
        });
        setDraft('');
      } else if (pinDrag.current) {
        const pd = pinDrag.current;
        if (!pd.moved && activeRef.current !== pd.i) {
          setSelPin((s) => (s === pd.i ? null : pd.i));
        }
        pinDrag.current = null;
      } else if (bubbleDrag.current) {
        bubbleDrag.current = null;
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 입력 단계(active 핀의 fi)가 바뀌면 그 필드 기존값을 입력칸에 prefill + 전체선택/포커스 → 타자 즉시 교체.
  // deps 는 [active, activeFi] 만 — 우측 grid 편집(vals 변경)으로는 fi 가 안 변해 포커스를 빼앗지 않는다.
  const activeFi = active != null ? pins[active]?.fi : undefined;
  useEffect(() => {
    if (active == null) return;
    const p = pinsRef.current[active];
    if (!p || p.fi >= FIELDS.length) return;
    const cur = p.vals[FIELDS[p.fi]] || '';
    setDraft(FIELDS[p.fi] === '단가' ? formatWon(cur) : cur);
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeFi]);

  // 창 크기 변경 시 표시 이미지 폭 갱신(말풍선 flip 판정용).
  useEffect(() => {
    const onResize = () => setStageW(imgRef.current?.clientWidth || 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 삭제버튼(selPin)이 열린 상태에서 점/삭제버튼 외 다른 곳을 누르면 닫는다.
  // 점·삭제버튼은 onMouseDown 에서 stopPropagation 하므로 이 window 리스너에 안 잡힌다.
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (selPinRef.current == null) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest && t.closest('.aq-dot, .aq-pindel')) return;
      setSelPin(null);
    };
    window.addEventListener('mousedown', onDocDown);
    return () => window.removeEventListener('mousedown', onDocDown);
  }, []);

  const startStageDrag = (e: React.MouseEvent) => {
    // 삭제버튼(selPin)이 열려 있으면 사진 클릭은 "삭제버튼 닫기"로만 — 새 핀은 안 만든다.
    if (selPinRef.current != null) {
      setSelPin(null);
      return;
    }
    if (activeRef.current !== null) return;
    e.preventDefault();
    const st = stageRef.current?.getBoundingClientRect();
    drag.current = { ax: e.clientX - (st?.left ?? 0), ay: e.clientY - (st?.top ?? 0), moved: false };
  };

  const startPinDrag = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const p = pins[i];
    pinDrag.current = { i, mx: e.clientX, my: e.clientY, ax: p.ax, ay: p.ay, lx: p.lx, ly: p.ly, moved: false };
  };

  // 말풍선(텍스트박스) 잡아서 이동 — 태그가 핸들. 점은 고정, 말풍선 위치만 이동.
  const startBubbleDrag = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const p = pins[i];
    bubbleDrag.current = { i, mx: e.clientX, my: e.clientY, lx: p.lx, ly: p.ly, moved: false };
  };

  const closeActive = () => {
    setActive(null);
    setDraft('');
  };

  // 현재 필드(fi)를 커밋하고 다음 필드로. 마지막이면 닫는다. (다음 필드 기존값 prefill+선택은 포커스 effect 가.)
  const commitDraft = () => {
    if (active == null) return;
    const val = draft.trim();
    setPins((prev) => {
      const next = prev.map((p, i) => {
        if (i !== active) return p;
        const np = { ...p, vals: { ...p.vals, [FIELDS[p.fi]]: val }, fi: p.fi + 1 };
        if (np.splitPending && FIELDS[np.fi - 1] === '품목') {
          np.fi = FIELDS.indexOf('단가');
          np.splitPending = false;
        }
        return np;
      });
      if (next[active] && next[active].fi >= FIELDS.length) setActive(null);
      return next;
    });
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Escape') {
      closeActive();
    }
  };

  const deletePin = (i: number) => {
    setPins((prev) => prev.filter((_, j) => j !== i));
    setActive((a) => (a != null && a > i ? a - 1 : a === i ? null : a));
    setSelPin(null);
  };

  // 말풍선 더블클릭 → 품목코드(fi=0)부터 입력/수정. Enter 로 다음 필드 진행.
  const startEdit = (i: number) => {
    setSelPin(null);
    setActive(i);
    setPins((prev) => prev.map((p, j) => (j === i ? { ...p, fi: 0, splitPending: false } : p)));
    // draft(기존값) prefill + 포커스/전체선택은 포커스 effect 가 처리.
  };

  // ---- grid 편집 -------------------------------------------------------
  const setCell = (i: number, key: string, value: string) => {
    if (key === '단가') value = formatWon(value); // 단가 셀도 천 단위 콤마.
    setPins((prev) => {
      const next = [...prev];
      if (!next[i]) {
        next[i] = { ax: 30, ay: 30 + i * 30, lx: 30, ly: 30 + i * 30, dragged: false, vals: {}, fi: FIELDS.length };
      }
      next[i] = { ...next[i], vals: { ...next[i].vals, [key]: value } };
      return next;
    });
  };

  const total = pins.reduce((s, p) => s + (num(p.vals['단가']) || 0) * (num(p.vals['수량']) || 1), 0);

  // ---- 계산기 ----------------------------------------------------------
  const applyResult = (unit: number, qty: number, desc: string) => {
    if (active == null) return;
    setPins((prev) =>
      prev.map((p, i) =>
        i === active ? { ...p, vals: { ...p.vals, 수량: String(qty), 단가: String(unit) }, fi: FIELDS.length } : p,
      ),
    );
    setActive(null);
    setDraft('');
    cdlg(
      `${desc}<br><b>${unit.toLocaleString()}원</b> × ${qty}자 = <b>${(unit * qty).toLocaleString()}원</b><br>` +
        `<span style="font-size:12px;color:#6b7785">수량·단가가 채워졌어요</span>`,
      [{ label: '확인' }],
    );
  };

  const splitMixed = (p: Pin, item: string) => {
    const ko = item.replace(/[^가-힣\s]/g, '').replace(/\s+/g, ' ').trim();
    const idx = active!;
    setPins((prev) => {
      const cur = { ...prev[idx], vals: { ...prev[idx].vals } };
      if (ko) cur.vals['품목'] = ko; // 현재 핀 = 한글만
      const np: Pin = {
        ax: p.ax,
        ay: p.ay,
        lx: p.lx + 18,
        ly: p.ly + (p.dragged ? 46 : 36),
        dragged: p.dragged,
        vals: { 품목코드: p.vals['품목코드'] || '', 규격: p.vals['규격'] || '' },
        fi: 1, // 품목부터 입력
        splitPending: true, // 품목 입력 후 단가로 점프
      };
      const next = [...prev];
      next[idx] = cur;
      next.splice(idx + 1, 0, np);
      return next;
    });
    setActive(idx + 1);
    setDraft('');
  };

  const runCalc = () => {
    if (active == null) return;
    const p = pins[active];
    const code = p.vals['품목코드'] || '';
    const item = p.vals['품목'] || '';
    const spec = p.vals['규격'] || '';
    const pc = parseCode(code);
    if (!pc) {
      cdlg('품목코드에서 계산기 종류를 못 읽었어요.<br>예: <b>아크릴3T</b> · <b>포맥스5T</b> · <b>고무스카시10T</b>', [
        { label: '확인', sec: true },
      ]);
      return;
    }
    if (!item) {
      cdlg('품목(글자)을 먼저 입력하세요', [{ label: '확인', sec: true }]);
      return;
    }
    if (pc.calc === 'acryl') {
      const tk = pc.tk;
      const hasKo = /[가-힣]/.test(item);
      const hasEn = /[A-Za-z]/.test(item);
      const doApply = (tt: '한글' | '영문', cmode: 'ko' | 'en' | 'all') => {
        const r = computeAcryl(CALC, tk || '', tt, item, spec, cmode);
        if (r.ok) applyResult(r.unit, r.qty, r.desc);
        else cdlg(r.message, [{ label: '확인', sec: true }]);
      };
      if (hasKo && hasEn) {
        cdlg('품목에 한글과 영문이 함께 있어요.<br><b>한글/영문을 분리</b>하시겠습니까?', [
          { label: '분리하기', fn: () => splitMixed(p, item) },
          {
            label: '분리 안 함',
            sec: true,
            fn: () =>
              cdlg('어느 단가로 적용할까요?', [
                { label: '한글 단가', fn: () => doApply('한글', 'all') },
                { label: '영문 단가', fn: () => doApply('영문', 'all') },
              ]),
          },
        ]);
        return;
      }
      doApply(hasKo ? '한글' : '영문', hasKo ? 'ko' : 'en');
    } else if (pc.calc === 'gomu') {
      const r = computeGomu(CALC, pc.tk, item, spec);
      if (r.ok) applyResult(r.unit, r.qty, r.desc);
      else cdlg(r.message, [{ label: '확인', sec: true }]);
    } else {
      // 내부 계산기 키(epoxy 등) 대신 사용자가 적은 품목코드를 보여준다. HTML 이스케이프.
      const codeLabel = (code || pc.calc).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] || c);
      cdlg(
        `이 품목(<b>${codeLabel}</b>)은 즉시계산 미지원 — admin/prices 계산기 페이지에서 확인하세요.<br>(현재 아크릴/포맥스·고무스카시만 지원)`,
        [{ label: '확인', sec: true }],
      );
    }
  };

  // ---- 단가 찾아보기 (slice-11 predict + evidence) ----------------------
  const openLookup = async () => {
    if (active == null) return;
    const p = pins[active];
    const code = p.vals['품목코드'] || '';
    const item = p.vals['품목'] || '';
    const spec = p.vals['규격'] || '';
    const qty = p.vals['수량'] || '';
    const client = order?.clientCompanyName || '';
    setStatus('과거 단가 조회 중…');
    try {
      const preds = await predict(token, client, [
        { text: `${code} ${item}`.trim(), material: code, size: spec, qty },
      ]);
      if (preds == null) {
        cdlg('학습 데이터(코퍼스)가 서버에 아직 없습니다. 관리자에게 R2 업로드를 요청하세요.', [{ label: '확인', sec: true }]);
        setStatus('');
        return;
      }
      const refs: LookupRef[] = [];
      for (const pr of preds) {
        let ev: Evidence | null = null;
        try {
          ev = await fetchEvidence(token, pr.ref_invoice_idx, pr.ref_file);
        } catch {
          ev = null;
        }
        refs.push({ reason: pr.reason, src: pr.src, price: pr.price, evidence: ev, hitPrice: pr.price });
      }
      const q = `"${(code + ' ' + item).trim() || '품목'}${spec ? ' / ' + spec : ''}"${client ? ' · ' + client : ''}`;
      setLookup({ refs, ri: 0, q });
      setStatus('');
    } catch (e) {
      console.error(e);
      cdlg('단가 조회에 실패했습니다.', [{ label: '확인', sec: true }]);
      setStatus('');
    }
  };

  const applyPrice = (price: number | string) => {
    setDraft(String(price));
    setLookup(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // ---- 저장 (slice-12 estimate API) ------------------------------------
  const buildGrid = () => {
    const today = todayMD();
    return pins.map((p) => {
      const dp = num(p.vals['단가']);
      return {
        월일: p.vals['월일'] || today,
        품목코드: p.vals['품목코드'] || '',
        품목: p.vals['품목'] || '',
        규격: p.vals['규격'] || '',
        수량: p.vals['수량'] || '',
        단가: p.vals['단가'] || '',
        공급가액: dp != null ? String(dp) : '',
        세액: dp != null ? String(Math.round(dp * 0.1)) : '',
        비고: p.vals['비고'] || '',
      };
    });
  };

  const save = async () => {
    if (!order) {
      cdlg('주문 컨텍스트가 없습니다. 주문 상세에서 “명세서작성”으로 들어오세요.', [{ label: '확인', sec: true }]);
      return;
    }
    setSaving(true);
    try {
      await putEstimate(token, order.id, { grid: buildGrid(), total, savedFrom: 'autoquote' });
      setOrder((o) => (o ? { ...o, hasEstimate: true } : o));
      onSaved?.();
      cdlg('명세서가 저장됐어요. 주문 카드/모달에 “명세서” 배지가 표시됩니다.', [{ label: '확인' }]);
    } catch (e) {
      console.error(e);
      cdlg('저장에 실패했습니다.', [{ label: '확인', sec: true }]);
    } finally {
      setSaving(false);
    }
  };

  // ---- 공유 (Canvas 합성 → 클립보드) ------------------------------------
  const captureShare = () => {
    const img = imgRef.current;
    if (!img || !imgSrc) {
      cdlg('사진을 먼저 붙여넣으세요.', [{ label: '확인', sec: true }]);
      return;
    }
    const nw = img.naturalWidth,
      nh = img.naturalHeight,
      dw = img.clientWidth,
      dh = img.clientHeight;
    const sx = nw / dw,
      sy = nh / dh;
    const cv = document.createElement('canvas');
    cv.width = nw;
    cv.height = nh;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(img, 0, 0, nw, nh);
    } catch {
      cdlg('이미지 처리 실패', [{ label: '확인', sec: true }]);
      return;
    }
    const fs = Math.max(13, Math.round(13 * sx));
    ctx.font = '700 ' + fs + 'px sans-serif';
    ctx.textBaseline = 'middle';
    pins.forEach((p, i) => {
      const t = pinLabel(p);
      if (!t) return;
      const c = pinColor(i);
      const ax = p.ax * sx,
        ay = p.ay * sy,
        lx = p.lx * sx,
        ly = p.ly * sy;
      const padx = fs * 0.7,
        h = fs * 1.85,
        w = ctx.measureText(t).width + padx * 2,
        r = fs * 0.45;
      let bx: number, by: number;
      if (p.dragged) {
        bx = lx + 10 * sx;
        by = ly - h / 2;
        ctx.strokeStyle = c;
        ctx.lineWidth = fs * 0.16;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(lx, ly);
        ctx.stroke();
      } else {
        bx = ax - 10 * sx;
        by = ay - 9 * sx - h;
      }
      // 말풍선이 캔버스 우측을 넘으면 안쪽으로 당겨 그린다(편집 화면 flip 과 일관).
      if (bx + w > cv.width - 2) bx = cv.width - w - 2;
      if (bx < 2) bx = 2;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + w, by, bx + w, by + h, r);
      ctx.arcTo(bx + w, by + h, bx, by + h, r);
      ctx.arcTo(bx, by + h, bx, by, r);
      ctx.arcTo(bx, by, bx + w, by, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(t, bx + padx, by + h / 2);
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(ax, ay, fs * 0.35, 0, 7);
      ctx.fill();
      ctx.lineWidth = fs * 0.12;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
    cv.toBlob(async (blob) => {
      if (!blob) {
        cdlg('캡쳐 실패(샘플 이미지는 보안제한 — 붙여넣은 사진으로 시도하세요).', [{ label: '확인', sec: true }]);
        return;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        cdlg('✓ 사진+말풍선이 복사됐어요. 카톡에서 Ctrl+V 로 붙여넣으세요.', [{ label: '확인' }]);
      } catch {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '견적.png';
        a.click();
        cdlg('클립보드 복사가 막혀 이미지로 저장했어요.', [{ label: '확인' }]);
      }
    }, 'image/png');
  };

  // ---- 렌더 ------------------------------------------------------------
  const today = todayMD();
  const rows = Math.max(ROWS, pins.length);

  return (
    <div className="aq-root">
      <div className="aq-bar">
        <b>자동견적</b>
        <span className="aq-hint">{status}</span>
        <span className="aq-sp" />
        <button
          className="aq-x"
          title="초기화"
          onClick={() => {
            setPins([]);
            setActive(null);
            setSelPin(null);
          }}
        >
          ↺
        </button>
        {onClose && (
          <button className="aq-x aq-close" title="닫기" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="aq-wrap">
        <div className="aq-stagewrap">
          {!imgSrc ? (
            <div className="aq-empty">
              📋
              <br />
              작업지시서 이미지를 붙여넣으세요
              <br />
              <span style={{ fontSize: 12 }}>Ctrl + V</span>
            </div>
          ) : (
            <div className="aq-stage" ref={stageRef}>
              {/* crossOrigin 미설정 — R2 공개 URL 이 CORS 헤더를 안 줘서 anonymous 면 이미지가 깨진다.
                  로드 우선. 공유 캔버스가 taint 로 막히면 PNG 다운로드로 폴백한다. */}
              <img
                ref={imgRef}
                src={imgSrc}
                alt="작업지시서"
                onMouseDown={startStageDrag}
                onLoad={() => setStageW(imgRef.current?.clientWidth || 0)}
                draggable={false}
              />
              <svg className="aq-lines">
                {pins.map((p, i) =>
                  p.dragged ? (
                    <line key={i} x1={p.ax} y1={p.ay} x2={p.lx} y2={p.ly} stroke={pinColor(i)} strokeWidth={2} />
                  ) : null,
                )}
                {ghost && <line x1={ghost.ax} y1={ghost.ay} x2={ghost.x} y2={ghost.y} stroke="#0a9396" strokeWidth={2} strokeDasharray="5 4" />}
              </svg>

              {/* 핀 점 */}
              {pins.map((p, i) => (
                <div
                  key={'dot' + i}
                  className="aq-dot"
                  style={{ left: p.ax, top: p.ay, background: pinColor(i) }}
                  title={`드래그=이동 · 클릭=삭제 (${i + 1}번 행)`}
                  onMouseDown={(e) => startPinDrag(e, i)}
                >
                  {i + 1}
                </div>
              ))}

              {/* 삭제 버튼 */}
              {selPin != null && selPin !== active && pins[selPin] && (
                <button
                  className="aq-pindel"
                  style={{ left: pins[selPin].ax, top: pins[selPin].ay }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    deletePin(selPin);
                  }}
                >
                  🗑 삭제
                </button>
              )}

              {/* 말풍선 + 입력 */}
              {pins.map((p, i) => {
                const isActive = i === active;
                const label = pinLabel(p); // 채워진 값 전체를 " / " 로
                const bubbleW = isActive ? 360 : Math.min(360, label.length * 8 + 60);
                const overflow = stageW > 0 && p.lx + bubbleW > stageW;
                const pinRight = overflow && p.dragged;
                const flipUp = overflow && !p.dragged;
                const cls =
                  'aq-lbl' + (p.dragged ? '' : ' up') + (pinRight ? ' pinright' : '') + (flipUp ? ' flip' : '');
                return (
                  <div key={'lbl' + i} className={cls} style={{ left: pinRight ? stageW : p.lx, top: p.ly }}>
                    {/* 말풍선 태그 — 드래그=이동, 더블클릭=품목코드부터 입력/수정. */}
                    <div
                      className={'aq-pintag' + (label ? '' : ' empty')}
                      style={{ background: pinColor(i) }}
                      title="드래그=이동 · 더블클릭=처음부터 입력/수정"
                      onMouseDown={(e) => startBubbleDrag(e, i)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEdit(i);
                      }}
                    >
                      {label || '✎ 더블클릭하여 입력'}
                    </div>
                    {isActive && (
                      <>
                        <div className="aq-pinrow">
                          <input
                            ref={inputRef}
                            value={draft}
                            placeholder={`${FIELDS[p.fi] ?? ''} 입력 후 Enter`}
                            autoComplete="off"
                            inputMode={FIELDS[p.fi] === '단가' || FIELDS[p.fi] === '수량' ? 'numeric' : undefined}
                            onChange={(e) => setDraft(FIELDS[p.fi] === '단가' ? formatWon(e.target.value) : e.target.value)}
                            onKeyDown={onInputKey}
                            onMouseDown={(e) => e.stopPropagation()}
                          />
                          <button
                            className="aq-pinx"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={closeActive}
                            title="닫기"
                          >
                            ✕
                          </button>
                        </div>
                        {FIELDS[p.fi] === '단가' && (
                          <div className="aq-lkrow">
                            <button className="aq-lookup" onMouseDown={(e) => e.stopPropagation()} onClick={openLookup}>
                              🔎 단가 찾아보기
                            </button>
                            <button className="aq-lookup calc" onMouseDown={(e) => e.stopPropagation()} onClick={runCalc}>
                              🧮 계산기
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}

              {/* 드래그하는 동안 반투명 미리보기 말풍선 — 떼면 여기에 실제 입력칸이 생긴다. */}
              {ghost &&
                (() => {
                  const gpr = stageW > 0 && ghost.x + 360 > stageW;
                  return (
                    <div className={'aq-lbl ghost' + (gpr ? ' pinright' : '')} style={{ left: gpr ? stageW : ghost.x, top: ghost.y }}>
                      <div className="aq-pintag">여기에 입력</div>
                      <div className="aq-pinrow">
                        <input placeholder="품목코드 입력 후 Enter" readOnly disabled />
                        <button className="aq-pinx" disabled>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })()}
            </div>
          )}
        </div>

        {/* 우측 이지폼 grid */}
        <div className="aq-side">
          <div className="aq-h">
            <b>견적 (이지폼)</b>
            {order && <span className="aq-tag">{order.clientCompanyName || order.orderNumber}</span>}
          </div>
          <div className="aq-gridwrap">
            <table className="aq-tbl">
              <colgroup>
                <col style={{ width: 30 }} />
                <col style={{ width: 44 }} />
                <col style={{ width: 66 }} />
                <col />
                <col style={{ width: 62 }} />
                <col style={{ width: 40 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 66 }} />
                <col style={{ width: 50 }} />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th>월일</th>
                  <th>품목코드</th>
                  <th>품목</th>
                  <th>규격</th>
                  <th>수량</th>
                  <th className="p">단가</th>
                  <th className="p">공급가액</th>
                  <th className="p">세액</th>
                  <th>비고</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, i) => {
                  const p = pins[i];
                  const v = p ? p.vals : {};
                  const dp = num(v['단가']);
                  const sup = dp != null ? dp : '';
                  const tax = dp != null ? Math.round(dp * 0.1) : '';
                  const md = v['월일'] != null && v['월일'] !== '' ? v['월일'] : p ? today : '';
                  return (
                    <tr key={i} className={i === active ? 'cur' : undefined}>
                      <td className="rn">{p && <span className="rnum" style={{ background: pinColor(i) }}>{i + 1}</span>}</td>
                      <td>
                        <input value={md} onChange={(e) => setCell(i, '월일', e.target.value)} />
                      </td>
                      <td>
                        <input value={v['품목코드'] || ''} onChange={(e) => setCell(i, '품목코드', e.target.value)} />
                      </td>
                      <td className="it">
                        <input value={v['품목'] || ''} onChange={(e) => setCell(i, '품목', e.target.value)} />
                      </td>
                      <td>
                        <input value={v['규격'] || ''} onChange={(e) => setCell(i, '규격', e.target.value)} />
                      </td>
                      <td>
                        <input value={v['수량'] || ''} onChange={(e) => setCell(i, '수량', e.target.value)} />
                      </td>
                      <td className="p">
                        <input value={v['단가'] || ''} onChange={(e) => setCell(i, '단가', e.target.value)} />
                      </td>
                      <td className="p">
                        <input readOnly value={sup === '' ? '' : String(sup)} />
                      </td>
                      <td className="p">
                        <input readOnly value={tax === '' ? '' : String(tax)} />
                      </td>
                      <td>
                        <input value={v['비고'] || ''} onChange={(e) => setCell(i, '비고', e.target.value)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="aq-foot">
            <div className="aq-tot">
              <span>합계</span>
              <b>{total.toLocaleString()}원</b>
            </div>
            <button className="aq-btn ef" onClick={save} disabled={saving || !order}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button className="aq-btn sh" onClick={captureShare}>
              공유하기
            </button>
            <button
              className="aq-btn ef"
              onClick={() =>
                cdlg('이지폼 새로작성 → 거래처 선택 → 시작하기 를 누르면, 위 행이 자동기입됩니다. (매크로는 slice-14에서 연결)', [
                  { label: '확인' },
                ])
              }
            >
              이지폼 입력
            </button>
          </div>
        </div>
      </div>

      {/* 단가 찾아보기 모달 */}
      {lookup && (
        <div className="aq-modal on" onClick={(e) => e.target === e.currentTarget && setLookup(null)}>
          <div className="aq-mbox">
            <div className="aq-mhead">
              <b>단가 찾아보기</b>
              <span className="aq-q">{lookup.q} · 예측 단가·근거</span>
              <span className="aq-nav">
                <button onClick={() => setLookup((l) => (l && l.ri > 0 ? { ...l, ri: l.ri - 1 } : l))}>‹</button>
                <span style={{ fontSize: 12.5, color: '#6b7785' }}>
                  {lookup.refs.length ? `${lookup.ri + 1} / ${lookup.refs.length}` : '0'}
                </span>
                <button onClick={() => setLookup((l) => (l && l.ri < l.refs.length - 1 ? { ...l, ri: l.ri + 1 } : l))}>
                  ›
                </button>
                <button className="aq-x" onClick={() => setLookup(null)}>
                  ×
                </button>
              </span>
            </div>
            {!lookup.refs.length ? (
              <div className="aq-mbody">
                <div className="aq-mleft">
                  <div className="none">관련 과거 단가가 없습니다. 품목코드/품목을 확인해 보세요.</div>
                </div>
                <div className="aq-mright" />
              </div>
            ) : (
              (() => {
                const R = lookup.refs[lookup.ri];
                const ev = R.evidence;
                const photo =
                  ev?.photo_available && ev.photo_base64
                    ? `data:${ev.photo_content_type || 'image/jpeg'};base64,${ev.photo_base64}`
                    : null;
                return (
                  <div className="aq-mbody">
                    <div className="aq-mleft">
                      {photo ? <img src={photo} alt="과거 작업지시서" /> : <div className="none">사진 없음</div>}
                    </div>
                    <div className="aq-mright">
                      <div className="aq-rinfo">
                        예측 단가 <b>{Number(R.price).toLocaleString()}원</b>
                        <span className="samebadge">{R.src}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7785', margin: '6px 0' }}>{R.reason}</div>
                      <button className="aq-btn sh" style={{ marginBottom: 10 }} onClick={() => applyPrice(R.price)}>
                        이 단가 적용 →
                      </button>
                      <div style={{ fontSize: 12, color: '#6b7785', marginBottom: 6 }}>
                        과거 명세서 — 행을 클릭하면 그 단가가 입력됩니다.
                      </div>
                      <table className="aq-rtbl">
                        <thead>
                          <tr>
                            <th>품목코드</th>
                            <th>품목</th>
                            <th>규격</th>
                            <th>수량</th>
                            <th className="p">단가</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {(ev?.grid || []).map((g, j) => {
                            const price = num(g.unit_price);
                            const hit = price != null && price === Math.round(Number(R.hitPrice));
                            const clk = price != null && price > 0;
                            return (
                              <tr
                                key={j}
                                className={(hit ? 'hit ' : '') + (clk ? 'click' : '')}
                                onClick={clk ? () => applyPrice(price as number) : undefined}
                              >
                                <td>{g.item_code || ''}</td>
                                <td>{g.item || ''}</td>
                                <td>{g.spec || ''}</td>
                                <td>{g.qty ?? ''}</td>
                                <td className="p">{g.unit_price ?? ''}</td>
                                <td>{clk ? <span className="pick">선택 →</span> : ''}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>
      )}

      {/* 작은 다이얼로그 */}
      {dialog && (
        <div className="aq-cdlg on" onClick={(e) => e.target === e.currentTarget && setDialog(null)}>
          <div className="aq-cdbox">
            <div className="aq-cdmsg" dangerouslySetInnerHTML={{ __html: dialog.html }} />
            <div className="aq-cdbtns">
              {dialog.buttons.map((b, i) => (
                <button
                  key={i}
                  className={b.sec ? 'sec' : undefined}
                  onClick={() => {
                    setDialog(null);
                    b.fn?.();
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
