import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  fi: number;
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

function pinLabel(p: Pin): string {
  return FIELDS.slice(0, p.fi)
    .map((f) => {
      const v = p.vals[f];
      if (v == null || v === '') return null;
      if (f === '수량') return v + '개';
      if (f === '단가') {
        const n = num(v);
        return (n != null ? n.toLocaleString() : v) + '원';
      }
      return v;
    })
    .filter(Boolean)
    .join(' / ');
}

function todayMD(): string {
  const d = new Date();
  return ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2);
}

export default function AutoQuote() {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();

  const [pins, setPins] = useState<Pin[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [selPin, setSelPin] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [imgSrc, setImgSrc] = useState<string | null>(null);
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
  const [ghost, setGhost] = useState<{ x: number; y: number; ax: number; ay: number } | null>(null);

  const cdlg = useCallback((html: string, buttons: DialogButton[]) => setDialog({ html, buttons }), []);

  // ---- ?order=ID 진입 시 지시서 이미지 + 저장된 명세서 자동 로드 -----------
  useEffect(() => {
    const raw = searchParams.get('order');
    if (!raw) return;
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) return;
    let alive = true;
    (async () => {
      try {
        const o = await getOrder(token, id);
        if (!alive || !o) return;
        setOrder(o);
        const url = o.worksheetThumbnailUrl || o.worksheetPdfUrl || null;
        if (url && !/\.pdf($|\?)/i.test(url)) {
          setImgSrc(url);
          setStatus(`${o.clientCompanyName || ''} · ${o.title || o.orderNumber} — 지시서 자동 로드됨`);
        } else {
          setStatus(`${o.clientCompanyName || ''} · ${o.orderNumber} — 지시서 이미지를 붙여넣으세요 (PDF는 캡쳐 붙여넣기)`);
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
  }, [searchParams, token]);

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
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // active 핀이 바뀌면 입력 포커스.
  useEffect(() => {
    if (active != null) inputRef.current?.focus();
  }, [active, pins]);

  const startStageDrag = (e: React.MouseEvent) => {
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

  const closeActive = () => {
    if (active == null) return;
    setPins((prev) => (prev[active] && prev[active].fi === 0 ? prev.filter((_, i) => i !== active) : prev));
    setActive(null);
    setDraft('');
  };

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
      const ap = next[active];
      if (ap && ap.fi >= FIELDS.length) setActive(null);
      return next;
    });
    setDraft('');
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

  const resumePin = (i: number) => {
    if (activeRef.current !== null) return;
    setSelPin(null);
    setActive(i);
    setDraft('');
  };

  // ---- grid 편집 -------------------------------------------------------
  const setCell = (i: number, key: string, value: string) => {
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
    setPins((prev) => {
      const idx = active!;
      const cur = { ...prev[idx], vals: { ...prev[idx].vals } };
      if (ko) cur.vals['품목'] = ko;
      const np: Pin = {
        ax: p.ax,
        ay: p.ay,
        lx: p.lx + 18,
        ly: p.ly + (p.dragged ? 46 : 36),
        dragged: p.dragged,
        vals: { 품목코드: p.vals['품목코드'] || '', 규격: p.vals['규격'] || '' },
        fi: 1,
        splitPending: true,
      };
      const next = [...prev];
      next[idx] = cur;
      next.splice(idx + 1, 0, np);
      return next;
    });
    setActive((a) => (a == null ? a : a + 1));
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
      cdlg(
        `이 품목(<b>${pc.calc}</b>)은 즉시계산 미지원 — admin/prices 계산기 페이지에서 확인하세요.<br>(현재 아크릴/포맥스·고무스카시만 지원)`,
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
    pins.forEach((p) => {
      const t = pinLabel(p);
      if (!t) return;
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
        ctx.strokeStyle = '#005f73';
        ctx.lineWidth = fs * 0.16;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(lx, ly);
        ctx.stroke();
      } else {
        bx = ax - 10 * sx;
        by = ay - 9 * sx - h;
      }
      ctx.fillStyle = '#005f73';
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
      ctx.fillStyle = '#005f73';
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
              <img
                ref={imgRef}
                src={imgSrc}
                crossOrigin={/^https?:/.test(imgSrc) ? 'anonymous' : undefined}
                alt="작업지시서"
                onMouseDown={startStageDrag}
                draggable={false}
              />
              <svg className="aq-lines">
                {pins.map((p, i) =>
                  p.dragged ? (
                    <line key={i} x1={p.ax} y1={p.ay} x2={p.lx} y2={p.ly} stroke="#005f73" strokeWidth={2} />
                  ) : null,
                )}
                {ghost && <line x1={ghost.ax} y1={ghost.ay} x2={ghost.x} y2={ghost.y} stroke="#0a9396" strokeWidth={2} strokeDasharray="5 4" />}
              </svg>

              {/* 핀 점 */}
              {pins.map((p, i) => (
                <div
                  key={'dot' + i}
                  className="aq-dot"
                  style={{ left: p.ax, top: p.ay }}
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
                const label = pinLabel(p) + (p.fi < FIELDS.length && i === active ? ' /' : '');
                const cls = 'aq-lbl' + (p.dragged ? '' : ' up');
                return (
                  <div
                    key={'lbl' + i}
                    className={cls}
                    style={{ left: p.lx, top: p.ly, cursor: i !== active && p.fi < FIELDS.length ? 'pointer' : undefined }}
                    onClick={i !== active && p.fi < FIELDS.length ? () => resumePin(i) : undefined}
                  >
                    {label && <div className="aq-pintag">{label}</div>}
                    {i === active && (
                      <>
                        <div className="aq-pinrow">
                          <input
                            ref={inputRef}
                            value={draft}
                            placeholder={`${FIELDS[p.fi]} 입력 후 Enter`}
                            autoComplete="off"
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={onInputKey}
                          />
                          <button className="aq-pinx" onClick={closeActive} title="닫기">
                            ✕
                          </button>
                        </div>
                        {FIELDS[p.fi] === '단가' && (
                          <div className="aq-lkrow">
                            <button className="aq-lookup" onClick={openLookup}>
                              🔎 단가 찾아보기
                            </button>
                            <button className="aq-lookup calc" onClick={runCalc}>
                              🧮 계산기
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
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
                      <td className="rn">{p && <span className="rnum">{i + 1}</span>}</td>
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
