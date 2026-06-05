import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  charCount,
} from './annot/calc';
import {
  lookupPrices,
  evidence as fetchEvidence,
  getOrder,
  getEstimate,
  putEstimate,
  markEasyformUploaded,
  readText,
  getVisionQuota,
  DailyLimitError,
  type Evidence,
  type OrderContext,
  type VisionQuota,
} from './annot/api';
import { probeEasyformAgent, fillEasyform, gridToEasyformRows } from './data/easyformClient';
import { matchCodes, didYouMean } from './itemCodes';
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
    // 고해상 렌더(확대해도 선명) — 가로 ~7200px 목표.
    // AutoQuote 는 이 비트맵을 CSS transform:scale(zoom) 로만 키우므로(PdfViewer 처럼 줌마다
    // 재렌더하지 않음), 줌 상한(10×)을 지원하려면 네이티브 해상도가 클수록 좋다. 표시폭(~1000px)
    // 기준 가로 7200px 면 ~7.2× 까지 1:1 이상으로 또렷하고, 거기서 10× 까지는 살짝 소프트하지만
    // 읽을 만하다. A4 세로 기준 높이 ~10180px(크롬·파이어폭스 캔버스 한계 안)·~73M px.
    const TARGET_W = 7200;
    const scale = Math.min(10, Math.max(2, TARGET_W / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.95);
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
/** '#rrggbb' → 'rgba(r,g,b,a)' — grid 행/박스 연한 틴트용. */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(10,147,150,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
/**
 * 품목코드가 계산 가능한 자재(아크릴/포맥스→acryl, 고무/스카시→gomu)면 규격(글자높이mm) 기준으로
 * 단가·수량(글자수)을 자동 계산해 돌려준다. 계산 대상이 아니거나 입력 부족/혼합(아크릴 한+영)이면 null.
 */
function computeAuto(code: string, item: string, spec: string): { unit: number; qty: number } | null {
  const pc = parseCode(code);
  if (!pc || (pc.calc !== 'acryl' && pc.calc !== 'gomu')) return null;
  if (!item || !spec) return null;
  if (pc.calc === 'gomu') {
    const r = computeGomu(CALC, pc.tk, item, spec);
    return r.ok ? { unit: r.unit, qty: r.qty } : null;
  }
  const hasKo = /[가-힣]/.test(item);
  const hasEn = /[A-Za-z]/.test(item);
  if (hasKo && hasEn) return null; // 한글+영문 혼합은 자동 안 함(계산기 버튼에서 분리/선택).
  const r = computeAcryl(CALC, pc.tk || '', hasKo ? '한글' : '영문', item, spec, hasKo ? 'ko' : 'en');
  return r.ok ? { unit: r.unit, qty: r.qty } : null;
}

/**
 * 품목을 newItem 으로 바꿀 때 수량을 따라가게 한 vals 를 만든다. 단, 수량이 '기존 품목의 글자수'와
 * 일치할 때만(=비전 자동입력 후 손대지 않은 동기 상태). 사용자가 수량을 직접 다르게 넣었으면 보존.
 */
function syncQty(oldVals: Record<string, string>, newItem: string): Record<string, string> {
  const v = { ...oldVals, 품목: newItem };
  const oldQty = num(oldVals['수량']);
  if (oldQty != null && oldQty === charCount(oldVals['품목'] || '', 'all')) {
    v['수량'] = String(charCount(newItem, 'all'));
  }
  return v;
}

// 공유 이미지용 한 줄 라벨 — "품목 규격 / 단가원 ×수량개 = 합계원".
function pinLabel(p: Pin): string {
  const top = [p.vals['품목'] ? `"${p.vals['품목']}"` : '', p.vals['규격']].filter(Boolean).join(' ');
  const dp = num(p.vals['단가']);
  const qty = num(p.vals['수량']) || 1;
  const priceLine = dp != null ? `${dp.toLocaleString()}원 ×${qty}개 = ${(dp * qty).toLocaleString()}원` : '';
  return [top, priceLine].filter(Boolean).join(' / ');
}

function todayMD(): string {
  const d = new Date();
  return ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2);
}

/**
 * 글자AI(OCR)로 읽은 텍스트를 품목 칸에 넣을 때 길이 축약 — 한글/혼합은 10자, 순수 영문은 20자
 * 초과 시 … 부착(이지폼 품목 50Byte 미만 제한 회피). 수량(글자수)은 원문 전체 기준으로 따로 보존하고,
 * 단가 계산은 수량 기준이라 영향 없다. 수기 입력엔 적용 안 함(createPinFromOcr 에서만 호출).
 */
function ocrTruncItem(s: string): string {
  const t = (s || '').trim();
  const chars = Array.from(t);
  const max = /[가-힣]/.test(t) ? 10 : 20; // 한글 또는 한글+영문 혼합=10, 순수 영문=20
  return chars.length > max ? chars.slice(0, max).join('') + '…' : t;
}

/** 글자수 모드 연필·지우개 굵기(화면 px). 콘텐츠 lineWidth = 이 값 / zoom 으로 화면상 일정하게. */
const BRUSH_SCREEN_PX: Record<'s' | 'm' | 'l', number> = { s: 12, m: 26, l: 46 };

/** 굵기 선택 버튼 안에 그릴 원 아이콘 지름(px) — 작은원/중간원/큰원. */
const BRUSH_DOT_PX: Record<'s' | 'm' | 'l', number> = { s: 7, m: 12, l: 18 };

/**
 * 마스크 슈퍼샘플 배율 — 마스크 캔버스 백킹 해상도 = 표시(콘텐츠) px × 이 값. 확대(zoom)해도
 * 캔버스가 흐려지지 않게 사진과 비슷한 해상도로 칠한다. 그리기 좌표는 모두 ×MASK_SS 로 변환.
 */
const MASK_SS = 3;

/** 되돌리기 최대 보관 수. PNG dataURL(빈 마스크는 수 KB)이라 메모리 부담 작아 20 까지. */
const MAX_UNDO = 20;

/** 마스크에 칠(알파)이 남아있는지 다운샘플(200px)로 빠르게 확인. 우리 캔버스라 taint 없음. */
function maskHasAnyInk(m: HTMLCanvasElement | null): boolean {
  if (!m || m.width === 0) return false;
  const sc = document.createElement('canvas');
  sc.width = 200;
  sc.height = Math.max(1, Math.round((200 * m.height) / m.width));
  const sctx = sc.getContext('2d');
  if (!sctx) return false;
  sctx.drawImage(m, 0, 0, sc.width, sc.height);
  const dd = sctx.getImageData(0, 0, sc.width, sc.height).data;
  for (let i = 3; i < dd.length; i += 4) {
    if (dd[i] > 8) return true;
  }
  return false;
}

/**
 * 연필·지우개 커서 — 브러시 지름만 한 원 + 우측상단에 도구 로고(연필/지우개)가 따라다닌다(SVG data URI).
 * 핫스팟(실제 칠 지점) = 원 중심. 연필 테두리는 말풍선 색, 지우개는 빨강.
 */
function brushCursor(diam: number, tool: 'pencil' | 'eraser', color: string): string {
  const d = Math.max(8, Math.round(diam));
  const ICON = 15; // 우측상단 로고 칸.
  const D = d + ICON;
  const cx = d / 2; // 원 중심 = 핫스팟.
  const cy = D - d / 2;
  const r = d / 2 - 1.5;
  const stroke = tool === 'eraser' ? '#ff5d5d' : color;
  const fill = tool === 'eraser' ? 'none' : hexToRgba(color, 0.22);
  const icon =
    tool === 'eraser'
      ? `<g transform='translate(${d},0)'><rect x='1' y='5' width='12' height='6' rx='1.5' transform='rotate(-32 7 8)' fill='#ff9ab5' stroke='#9a3f5e' stroke-width='1'/></g>`
      : `<g transform='translate(${d},0)' stroke='#6f521a' stroke-width='1' stroke-linejoin='round'>` +
        `<path d='M11 1 L14 4 L5 13 L1 14 L2 10 Z' fill='#f4c542'/><path d='M9.5 2.5 L12.5 5.5'/></g>`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${D}' height='${D}'>` +
    `<circle cx='${cx}' cy='${cy}' r='${r}' fill='${fill}' stroke='${stroke}' stroke-width='1.5'/>` +
    icon +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${cx} ${cy}, crosshair`;
}

/** keep-mask 캔버스에 한 선분을 칠하거나(연필) 지운다(지우개). 알파 채널이 곧 마스크. */
function paintMaskSegment(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tool: 'pencil' | 'eraser',
  lineWidth: number,
  color: string,
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color; // 말풍선 색(풀 알파). 표시 반투명은 CSS opacity 가 담당(겹침 누적 방지).
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

interface AutoQuoteProps {
  /** 모달 모드: 부모(주문 상세)가 주문 id 를 직접 주입. 없으면 ?order= 쿼리에서 읽음. */
  orderId?: number;
  /** 모달 닫기(상단 ✕). 주어지면 닫기 버튼 노출. */
  onClose?: () => void;
  /** 저장 성공 시 호출 — 부모가 주문 목록의 명세서 배지를 즉시 갱신. */
  onSaved?: () => void;
  /** 이지폼 입력(확정) 시 호출 — 부모가 목록 카드의 '명세서작성완료' 배지를 즉시 점등(작업중·작업완료 양쪽). */
  onEasyformUploaded?: () => void;
}

export default function AutoQuote({ orderId: orderIdProp, onClose, onSaved, onEasyformUploaded }: AutoQuoteProps = {}) {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();

  const [pins, setPins] = useState<Pin[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [selPin, setSelPin] = useState<number | null>(null);
  const [selectedPin, setSelectedPin] = useState<number | null>(null); // 복사용으로 클릭 선택된 말풍선.
  const [draft, setDraft] = useState('');
  const [acIdx, setAcIdx] = useState(-1); // 품목코드 자동완성 드롭다운 하이라이트(-1=없음)
  const [acAbove, setAcAbove] = useState(false); // 드롭다운을 입력칸 위로 열지(아래 공간 부족 시)
  const acDropRef = useRef<HTMLDivElement>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null); // 작업지시서 — 말풍선(핀)을 얹는 캔버스.
  const [refSrc, setRefSrc] = useState<string | null>(null); // 참고사진 — 보기 전용(붙여넣기). 지시서와 별개.
  const [showRef, setShowRef] = useState(false); // 스테이지에 참고사진 표시(true) / 지시서 표시(false).
  const [loadingImg, setLoadingImg] = useState(false); // 주문 진입 시 지시서 자동 로드 진행 중 — 빈화면에 "로딩중" 표시(붙여넣기 안내 대신).
  const [stageW, setStageW] = useState(0); // 표시 이미지 폭/높이 — 말풍선이 경계 넘치면 코너 기준 뒤집기.
  const [stageH, setStageH] = useState(0);
  const [zoom, setZoom] = useState(1); // 휠 확대 배율(1~10). 핀 좌표는 zoom 으로 나눠 변환.
  const [pan, setPan] = useState({ x: 0, y: 0 }); // 포커스 줌 시 이동(px, 화면좌표).
  const [mode, setMode] = useState<'cursor' | 'hand' | 'ocr'>('hand'); // 진입 기본=이동(1). 커서=핀 작성(2) / 손바닥=화면 이동 / 글자=영역 OCR(3)
  const [ocrSel, setOcrSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null); // 글자읽기 선택 박스(콘텐츠 좌표)
  const [ocrBusy, setOcrBusy] = useState(false); // 글자읽기 호출 진행 중
  const [ocrTool, setOcrTool] = useState<'box' | 'pencil' | 'eraser'>('box'); // 글자수 모드 하위 도구
  const [gridEditing, setGridEditing] = useState(false); // 우측 명세서 표를 수기 편집(셀 포커스) 중 — 다음행 하이라이트 끔
  const [visionQuota, setVisionQuota] = useState<VisionQuota | null>(null); // 글자AI 일일 한도(서버) — 버튼 옆 표시·사전 차단
  // 우측 표 품목코드 자동완성(말풍선과 동일) — 표는 overflow 클리핑이라 포털+fixed 로 띄운다.
  const [gridAc, setGridAc] = useState<{ row: number; idx: number; left: number; top: number; width: number } | null>(null);
  // 우측 표 단가칸 포커스 시 뜨는 계산기/단가찾아보기 툴바(말풍선과 동일). 포털+fixed.
  const [gridTool, setGridTool] = useState<{ row: number; left: number; top: number } | null>(null);
  const [brush, setBrush] = useState<'s' | 'm' | 'l'>('m'); // 연필·지우개 굵기(화면 px). S=12 M=26 L=46
  const [maskHasInk, setMaskHasInk] = useState(false); // 마스크에 칠한 영역이 있나 — [읽기] 버튼 활성 게이트
  const [order, setOrder] = useState<OrderContext | null>(null);
  const [status, setStatus] = useState('작업지시서 사진을 붙여넣으세요 (Ctrl+V)');
  const [saving, setSaving] = useState(false);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [lookup, setLookup] = useState<{ refs: LookupRef[]; ri: number; q: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const stagewrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  // window 마우스 핸들러가 최신 상태를 읽도록 ref 미러.
  const pinsRef = useRef(pins);
  const activeRef = useRef(active);
  const selPinRef = useRef(selPin);
  const draftRef = useRef(draft);
  const selectedPinRef = useRef<number | null>(null);
  const copyBufRef = useRef<Record<string, string> | null>(null); // Ctrl+C 로 복사한 말풍선 값.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  pinsRef.current = pins;
  activeRef.current = active;
  selPinRef.current = selPin;
  selectedPinRef.current = selectedPin;
  draftRef.current = draft;

  // 전역(stage 밖) 드래그 상태 — 렌더와 무관한 transient.
  const drag = useRef<{ ax: number; ay: number; moved: boolean } | null>(null);
  const pinDrag = useRef<
    { i: number; mx: number; my: number; ax: number; ay: number; lx: number; ly: number; moved: boolean } | null
  >(null);
  // 말풍선(텍스트박스) 자체를 잡아서 이동 — 태그를 핸들로. 점(앵커)은 고정, 말풍선 위치(lx,ly)만 이동.
  const bubbleDrag = useRef<{ i: number; mx: number; my: number; lx: number; ly: number; moved: boolean } | null>(null);
  // 화면 이동(팬) — 가운데 버튼 드래그 또는 손바닥 모드. 시작 시점 pan(px) 캡처.
  const panDrag = useRef<{ sx: number; sy: number; px: number; py: number; btn: number } | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null); // 최신 마우스 화면좌표(가장자리 자동 팬용)
  const [ghost, setGhost] = useState<{ x: number; y: number; ax: number; ay: number } | null>(null);
  // 글자읽기 영역 드래그 — 시작점(콘텐츠 좌표). 최신 performOcr 는 ref 로 호출(전역 핸들러가 [] deps).
  const ocrDrag = useRef<{ x0: number; y0: number; moved: boolean } | null>(null);
  // 마스크 캔버스(읽을 영역 색칠 = keep-mask). 알파 채널이 곧 마스크. 콘텐츠 해상도(stageW×stageH).
  const maskRef = useRef<HTMLCanvasElement>(null);
  // 되돌리기 스택 — 각 그리기/박스/지우기 직전 마스크 상태(PNG dataURL). 최대 MAX_UNDO.
  const undoRef = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  // 전역 핸들러(스냅샷 push)·버튼/단축키(undo)에서 최신 함수를 ref 로 호출.
  const pushUndoRef = useRef<() => void>(() => {});
  const undoMaskRef = useRef<() => void>(() => {});
  // 연필·지우개 스트로크 진행 상태 — 마지막 점(콘텐츠 좌표) + 현재 스트로크 bbox(첫 영역 중앙 산출용).
  const paintRef = useRef<{
    active: boolean;
    lastX: number;
    lastY: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  // 이번 마스크 세션에서 '첫 번째로 칠한 영역'의 중앙(콘텐츠 좌표). 읽은 뒤 새 말풍선을 여기 만든다.
  const firstAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // 최신 도구/굵기를 전역 핸들러가 읽도록 미러.
  const ocrToolRef = useRef(ocrTool);
  ocrToolRef.current = ocrTool;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const performOcrRef = useRef<() => void>(() => {});
  const maskHasInkRef = useRef(false);
  maskHasInkRef.current = maskHasInk;
  // 현재 OCR 타깃 말풍선의 색(박스·연필 색을 그 말풍선과 일치). 렌더에서 갱신.
  const ocrColorRef = useRef('#0a9396');

  const cdlg = useCallback((html: string, buttons: DialogButton[]) => setDialog({ html, buttons }), []);

  // ---- ?order=ID 진입 시 지시서 이미지 + 저장된 명세서 자동 로드 -----------
  useEffect(() => {
    const id = orderIdProp ?? Number(searchParams.get('order'));
    if (!Number.isFinite(id) || id <= 0) return;
    let alive = true;
    setLoadingImg(true); // 지시서 자동 로드 시작 — 빈화면에 "로딩중" 표시.
    (async () => {
      try {
        const o = await getOrder(token, id);
        if (!alive || !o) {
          if (alive) setLoadingImg(false);
          return;
        }
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
        if (alive) setLoadingImg(false); // 이미지 로드 끝(성공/폴백/없음) — 빈화면이면 붙여넣기 안내로 전환.
        // 기존 명세서가 있으면 grid 를 핀(앵커 없는 grid 행)으로 복원.
        const est = await getEstimate(token, id);
        if (alive && est?.estimate?.grid?.length) {
          const restored: Pin[] = est.estimate.grid.map((g: Record<string, unknown>, i: number) => {
            // 저장된 핀 위치(_ax…)가 있으면 원위치로, 없으면(옛 저장본) 좌상단 계단식 폴백.
            const hasGeo = g._ax != null && g._ay != null;
            const ax = hasGeo ? Number(g._ax) : 30;
            const ay = hasGeo ? Number(g._ay) : 30 + i * 30;
            return {
              ax,
              ay,
              lx: hasGeo && g._lx != null ? Number(g._lx) : ax,
              ly: hasGeo && g._ly != null ? Number(g._ly) : ay,
              dragged: hasGeo ? !!g._dragged : false,
              fi: FIELDS.length,
              vals: {
                월일: String(g['월일'] ?? ''),
                품목코드: String(g['품목코드'] ?? ''),
                품목: String(g['품목'] ?? ''),
                규격: String(g['규격'] ?? ''),
                수량: String(g['수량'] ?? ''),
                단가: String(g['단가'] ?? ''),
                비고: String(g['비고'] ?? ''),
              },
            };
          });
          setPins(restored);
        }
      } catch (e) {
        console.error(e);
        if (alive) setLoadingImg(false);
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
        const dataUrl = String(r.result);
        // 붙여넣은 이미지를 바로 깔지 않고, 참고사진으로 추가할지 먼저 묻는다(작업 중 실수 붙여넣기 방지).
        cdlg(
          `<b style="font-size:15px">참고사진을 추가하시겠습니까?</b>` +
            `<div style="font-size:12px;color:#6b7785;margin-top:6px">추가하면 이 사진을 보면서 명세서를 작성할 수 있어요. ` +
            `작성 후 상단 [지시서] 전환 → 표의 번호 동그라미를 사진 위로 드래그하면 그 칸 말풍선이 생깁니다.</div>`,
          [
            {
              label: '추가하기',
              fn: () => {
                setRefSrc(dataUrl); // 참고사진으로 보관(보기 전용).
                setImgSrc((prev) => prev || dataUrl); // 지시서가 없으면 이 사진을 지시서로도 사용(말풍선 캔버스 확보).
                setShowRef(true); // 바로 참고사진을 띄워 보면서 작성.
                setStatus('참고사진을 보며 명세서를 작성하세요 · 상단 [지시서] 전환 후 번호 동그라미를 드래그');
              },
            },
            { label: '취소', sec: true },
          ],
        );
      };
      r.readAsDataURL(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // ---- 전역 마우스 무브/업 (스테이지 드래그 + 핀 드래그) ------------------
  useEffect(() => {
    // 콘텐츠(이미지) 좌표 — 확대(zoom) 중이면 화면 px 를 zoom 으로 나눠 원본 좌표로 환산.
    const localXY = (e: MouseEvent) => {
      const st = stageRef.current?.getBoundingClientRect();
      const z = zoomRef.current || 1;
      return { x: (e.clientX - (st?.left ?? 0)) / z, y: (e.clientY - (st?.top ?? 0)) / z };
    };
    const onMove = (e: MouseEvent) => {
      const z = zoomRef.current || 1;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      // 팬(가운데버튼/손바닥)을 최우선 — 좌클릭 박스/칠 드래그 중에도 가운데버튼으로 화면 이동.
      if (panDrag.current) {
        const pd = panDrag.current;
        setPan({ x: pd.px + (e.clientX - pd.sx), y: pd.py + (e.clientY - pd.sy) });
        return;
      }
      // 연필·지우개 — 마지막점→현재점 선분을 마스크에 칠한다(콘텐츠 좌표).
      if (paintRef.current?.active) {
        const { x, y } = localXY(e);
        const m = maskRef.current;
        const mctx = m?.getContext('2d');
        const pr = paintRef.current;
        if (mctx) {
          // 콘텐츠 굵기 = 화면px/zoom, 백킹 좌표·굵기는 ×MASK_SS(슈퍼샘플).
          const lw = ((BRUSH_SCREEN_PX[brushRef.current] || 26) / z) * MASK_SS;
          const tool = ocrToolRef.current === 'eraser' ? 'eraser' : 'pencil';
          paintMaskSegment(mctx, pr.lastX * MASK_SS, pr.lastY * MASK_SS, x * MASK_SS, y * MASK_SS, tool, lw, ocrColorRef.current);
        }
        pr.lastX = x;
        pr.lastY = y;
        if (x < pr.minX) pr.minX = x;
        if (x > pr.maxX) pr.maxX = x;
        if (y < pr.minY) pr.minY = y;
        if (y > pr.maxY) pr.maxY = y;
        return;
      }
      if (ocrDrag.current) {
        const { x, y } = localXY(e);
        const od = ocrDrag.current;
        if (Math.abs(x - od.x0) > 3 || Math.abs(y - od.y0) > 3) od.moved = true;
        setOcrSel({ x: Math.min(x, od.x0), y: Math.min(y, od.y0), w: Math.abs(x - od.x0), h: Math.abs(y - od.y0) });
        return;
      }
      if (drag.current) {
        const { x, y } = localXY(e);
        if (Math.abs(x - drag.current.ax) > 4 || Math.abs(y - drag.current.ay) > 4) drag.current.moved = true;
        if (drag.current.moved) setGhost({ x, y, ax: drag.current.ax, ay: drag.current.ay });
        else setGhost(null);
      } else if (pinDrag.current) {
        const dx = (e.clientX - pinDrag.current.mx) / z;
        const dy = (e.clientY - pinDrag.current.my) / z;
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
        const dx = (e.clientX - bd.mx) / z;
        const dy = (e.clientY - bd.my) / z;
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
      // 팬 종료 — 팬을 시작한 그 버튼이 떼졌을 때만(좌클릭 박스/칠 드래그는 유지).
      if (panDrag.current && e.button === panDrag.current.btn) {
        panDrag.current = null;
        return;
      }
      if (e.button !== 0) return; // 이하 좌클릭 떼기만 — 박스/칠/핀 확정.
      // 연필·지우개 스트로크 종료.
      if (paintRef.current?.active) {
        const pr = paintRef.current;
        paintRef.current = null;
        if (ocrToolRef.current === 'eraser') {
          // 지우개는 칠을 더하지 않는다 → 지운 뒤 남은 칠이 있을 때만 ✓/✕ 활성.
          setMaskHasInk(maskHasAnyInk(maskRef.current));
        } else {
          // 연필 = 칠 추가. 이번 세션 첫 영역이면 그 스트로크 bbox 중앙을 앵커로(새 말풍선 위치).
          if (!firstAnchorRef.current) {
            firstAnchorRef.current = { x: (pr.minX + pr.maxX) / 2, y: (pr.minY + pr.maxY) / 2 };
          }
          setMaskHasInk(true);
        }
        return;
      }
      if (ocrDrag.current) {
        const { x, y } = localXY(e);
        const od = ocrDrag.current;
        ocrDrag.current = null;
        setOcrSel(null);
        const rect = { x: Math.min(x, od.x0), y: Math.min(y, od.y0), w: Math.abs(x - od.x0), h: Math.abs(y - od.y0) };
        // 박스 = 그 영역을 '읽을 영역'으로 마스크에 채움(즉시 읽지 않음). 너무 작으면 무시.
        if (od.moved && rect.w > 8 && rect.h > 8) {
          const m = maskRef.current;
          const mctx = m?.getContext('2d');
          if (mctx) {
            pushUndoRef.current(); // 박스 채우기 직전 상태 저장(되돌리기).
            mctx.save();
            mctx.globalCompositeOperation = 'source-over';
            mctx.fillStyle = ocrColorRef.current; // 말풍선 색.
            mctx.fillRect(rect.x * MASK_SS, rect.y * MASK_SS, rect.w * MASK_SS, rect.h * MASK_SS);
            mctx.restore();
            // 이번 세션 첫 영역이면 박스 중앙을 앵커로(새 말풍선 위치).
            if (!firstAnchorRef.current) {
              firstAnchorRef.current = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
            }
            setMaskHasInk(true);
          }
        }
        return;
      }
      if (drag.current) {
        const { x, y } = localXY(e);
        const dr = drag.current.moved;
        const ax = drag.current.ax;
        const ay = drag.current.ay;
        setGhost(null);
        drag.current = null;
        // 클릭만으로는 핀 생성 안 함 — 드래그(리더선)로만 생성. (제자리 말풍선 경계 문제 회피.)
        if (!dr) return;
        setSelPin(null);
        // 생성 즉시 입력칸 열기(품목코드부터). 이후 말풍선 더블클릭으로 다시 편집 가능.
        setPins((prev) => {
          const next = [...prev, { ax, ay, lx: x, ly: y, dragged: true, vals: {}, fi: 0 }];
          setActive(next.length - 1);
          return next;
        });
        setDraft('');
      } else if (pinDrag.current) {
        const pd = pinDrag.current;
        if (!pd.moved) {
          // 입력 중인 핀의 점을 클릭하면 입력을 닫고 삭제버튼을 띄운다(삭제버튼은 active 핀엔 안 뜨므로).
          if (activeRef.current === pd.i) setActive(null);
          setSelPin((s) => (s === pd.i ? null : pd.i));
        } else {
          // 점을 끌어다 놓음 → 아직 말풍선이 없던(수기) 핀이면 그때 말풍선을 펼친다.
          // 점 '우상단'에, 우측 공간이 부족하면 '좌상단'에(번호 동그라미 드롭과 동일 규칙).
          setPins((prev) =>
            prev.map((p, i) => {
              if (i !== pd.i || p.dragged) return p;
              const z2 = zoomRef.current || 1;
              const off = 70 / z2;
              const halfW = 180 / z2;
              const dw = imgRef.current?.clientWidth ?? 0;
              let lx = p.ax + off;
              const ly = p.ay - off;
              if (dw && lx + halfW > dw) lx = p.ax - off;
              return { ...p, lx, ly, dragged: true };
            }),
          );
        }
        pinDrag.current = null;
      } else if (bubbleDrag.current) {
        if (!bubbleDrag.current.moved) setSelectedPin(bubbleDrag.current.i); // 클릭=복사용 선택
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
    setAcIdx(-1); // 단계 바뀌면 자동완성 하이라이트 리셋.
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        // preventScroll — 입력칸이 화면 밖(확대/가장자리)에 생겨도 브라우저가 그걸 보이게
        // 모달/페이지를 스크롤해 툴바가 밀려나가지 않게 한다.
        el.focus({ preventScroll: true });
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeFi]);

  // 자동완성 하이라이트가 바뀌면 그 항목을 드롭다운 안에 보이게 스크롤(키보드 ↓ 로 5개 너머 탐색).
  useEffect(() => {
    if (acIdx < 0) return;
    acDropRef.current?.querySelector('.aq-acitem.on')?.scrollIntoView({ block: 'nearest' });
  }, [acIdx]);

  // 드롭다운은 입력칸을 밀지 않고 아래로 연다(절대배치). 단, 사진 영역 아래 공간이 부족하면 위로.
  // 입력칸/스테이지의 화면 좌표를 재 비교 — 말풍선 scale(1/zoom) 까지 반영된 실측값을 쓴다.
  useLayoutEffect(() => {
    const inp = inputRef.current,
      stage = stagewrapRef.current;
    if (!inp || !stage) return;
    const ir = inp.getBoundingClientRect(),
      sr = stage.getBoundingClientRect();
    const dh = acDropRef.current?.offsetHeight || 210; // 펼친 드롭다운 높이(없으면 추정).
    const below = sr.bottom - ir.bottom,
      above = ir.top - sr.top;
    setAcAbove(below < dh + 10 && above > below);
  }, [active, draft]);

  // 창 크기 변경 시 표시 이미지 폭 갱신(말풍선 flip 판정용).
  useEffect(() => {
    const onResize = () => {
      setStageW(imgRef.current?.clientWidth || 0);
      setStageH(imgRef.current?.clientHeight || 0);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 새 이미지 로드 시 줌/이동 초기화.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [imgSrc]);

  // 휠 = 포커스 확대/축소(커서 지점 고정). 핀 드래그는 그대로(좌표는 zoom 으로 변환).
  useEffect(() => {
    const el = stagewrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!imgSrc) return;
      // 품목코드 자동완성 드롭다운 위에서 휠 = 드롭다운 스크롤(줌 아님). preventDefault 전에 양보.
      if ((e.target as HTMLElement | null)?.closest?.('.aq-acdrop')) return;
      e.preventDefault();
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z = zoomRef.current;
      const cux = (e.clientX - rect.left) / z; // 커서 아래 콘텐츠 좌표
      const cuy = (e.clientY - rect.top) / z;
      const z2 = Math.max(1, Math.min(10, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (z2 === z) return;
      if (z2 === 1) setPan({ x: 0, y: 0 });
      else setPan((prev) => ({ x: prev.x + cux * (z - z2), y: prev.y + cuy * (z - z2) }));
      setZoom(z2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [imgSrc]);

  // 가장자리 자동 팬 — 확대 상태에서 박스/칠을 그리다 마우스를 지시서(뷰포트) 끝에 대면
  // 그 방향으로 조금씩 화면을 이동(좌클릭 유지한 채). 박스를 화면 밖까지 이어 그릴 수 있게.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const drawing = !!ocrDrag.current || !!paintRef.current?.active;
      if (!drawing || panDrag.current || zoomRef.current <= 1) return; // 가운데버튼 팬 중이면 양보.
      const wrap = stagewrapRef.current?.getBoundingClientRect();
      const p = pointerRef.current;
      if (!wrap || !p) return;
      const EDGE = 48,
        STEP = 16; // 가장자리 48px 안에 들어오면 프레임당 16px 씩 그 방향으로.
      let dx = 0,
        dy = 0;
      if (p.x > wrap.right - EDGE) dx = -STEP;
      else if (p.x < wrap.left + EDGE) dx = STEP;
      if (p.y > wrap.bottom - EDGE) dy = -STEP;
      else if (p.y < wrap.top + EDGE) dy = STEP;
      if (!dx && !dy) return;
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      // 팬 후(다음 프레임 stage 이동)를 미리 반영해 커서 아래 콘텐츠 좌표로 박스/스트로크를 이어붙인다.
      const st = stageRef.current?.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const x = (p.x - ((st?.left ?? 0) + dx)) / z;
      const y = (p.y - ((st?.top ?? 0) + dy)) / z;
      if (ocrDrag.current) {
        const od = ocrDrag.current;
        od.moved = true;
        setOcrSel({ x: Math.min(x, od.x0), y: Math.min(y, od.y0), w: Math.abs(x - od.x0), h: Math.abs(y - od.y0) });
      } else if (paintRef.current?.active) {
        const pr = paintRef.current;
        const mctx = maskRef.current?.getContext('2d');
        if (mctx) {
          const lw = ((BRUSH_SCREEN_PX[brushRef.current] || 26) / z) * MASK_SS;
          const tool = ocrToolRef.current === 'eraser' ? 'eraser' : 'pencil';
          paintMaskSegment(mctx, pr.lastX * MASK_SS, pr.lastY * MASK_SS, x * MASK_SS, y * MASK_SS, tool, lw, ocrColorRef.current);
        }
        pr.lastX = x;
        pr.lastY = y;
        if (x < pr.minX) pr.minX = x;
        if (x > pr.maxX) pr.maxX = x;
        if (y < pr.minY) pr.minY = y;
        if (y > pr.maxY) pr.maxY = y;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 말풍선 복사/붙여넣기 — 말풍선 클릭(선택) 후 Ctrl+C 로 값 복사, 다른 말풍선(선택/활성)에서 Ctrl+V 로 붙여넣기.
  // grid 등 다른 입력칸(텍스트박스)에서는 기본 복사/붙여넣기 동작을 유지.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Ctrl+Z = 글자수 마스크 되돌리기(입력칸 타이핑 중이 아닐 때).
      if (k === 'z' && modeRef.current === 'ocr') {
        const ae0 = document.activeElement as HTMLElement | null;
        if (ae0 && (ae0.tagName === 'INPUT' || ae0.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        undoMaskRef.current();
        return;
      }
      if (k !== 'c' && k !== 'v') return;
      const ae = document.activeElement as HTMLElement | null;
      const isPinInput = ae === inputRef.current;
      const isOtherInput = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !isPinInput;
      if (isOtherInput) return; // grid 등은 기본 복붙.
      if (k === 'c') {
        const src = activeRef.current != null ? activeRef.current : selectedPinRef.current;
        const p = src != null ? pinsRef.current[src] : null;
        if (p) {
          copyBufRef.current = { ...p.vals };
          e.preventDefault();
        }
      } else {
        const target = activeRef.current != null ? activeRef.current : selectedPinRef.current;
        if (copyBufRef.current && target != null) {
          e.preventDefault();
          const buf = copyBufRef.current;
          setPins((prev) => prev.map((p, idx) => (idx === target ? { ...p, vals: { ...buf }, fi: FIELDS.length } : p)));
          setActive(null);
          setDraft('');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 글자AI 일일 한도 — 진입 시(마운트) + 모드 전환 시 서버에서 '오늘 남은 횟수'를 새로 받아온다.
  useEffect(() => {
    getVisionQuota(token).then((q) => q && setVisionQuota(q));
  }, [token, mode]);

  // 마스크 캔버스 크기를 표시 이미지(콘텐츠)에 맞춘다. 캔버스 width/height 변경은 내용을 비우므로
  // 새 이미지/리사이즈 시 마스크가 초기화된다.
  useEffect(() => {
    const m = maskRef.current;
    if (!m) return;
    // 백킹 해상도 = 표시 px × MASK_SS (확대해도 선명). CSS 표시 크기는 인라인 style 로 표시 px.
    const bw = Math.round(stageW * MASK_SS);
    const bh = Math.round(stageH * MASK_SS);
    if (m.width !== bw || m.height !== bh) {
      m.width = bw;
      m.height = bh;
    }
    undoRef.current = [];
    firstAnchorRef.current = null;
    setCanUndo(false);
    setMaskHasInk(false);
  }, [stageW, stageH]);

  // 글자수 모드에서 Enter = [읽기]. 입력칸에 포커스 중이면 무시(말풍선 입력 방해 방지).
  useEffect(() => {
    if (mode !== 'ocr') return undefined;
    const onEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (!maskHasInkRef.current) return;
      e.preventDefault();
      performOcrRef.current();
    };
    window.addEventListener('keydown', onEnter);
    return () => window.removeEventListener('keydown', onEnter);
  }, [mode]);

  // 단축키 1/2/3 = 커서/지시서이동/글자수 모드. 입력칸에 타이핑 중이면 무시(숫자 입력 보존).
  useEffect(() => {
    const onNum = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== '1' && e.key !== '2' && e.key !== '3') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      e.preventDefault();
      if (e.key === '1') {
        setMode('hand'); // 1 = 지시서 이동
      } else if (e.key === '2') {
        setMode('cursor'); // 2 = 말풍선
      } else if (modeRef.current === 'ocr') {
        // 3 = 글자수. 이미 글자수 모드면 재입력 = 박스→연필→지우개 순환.
        setOcrTool((t) => (t === 'box' ? 'pencil' : t === 'pencil' ? 'eraser' : 'box'));
      } else {
        setMode('ocr');
      }
    };
    window.addEventListener('keydown', onNum);
    return () => window.removeEventListener('keydown', onNum);
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
    if (!imgSrc) return;
    // 지시서를 클릭하면 명세서(grid 등) 텍스트박스의 포커스를 푼다. preventDefault 로 기본 blur 가
    // 막히므로 명시적으로 처리. 단, 말풍선 입력칸(inputRef)은 유지(작성 흐름 보존).
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== inputRef.current && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
      ae.blur();
    }
    // 참고사진 보기 중 — 지시서 편집(핀 생성·칠하기) 금지. 확대 상태면 팬만 허용(참고사진 둘러보기).
    if (showRef) {
      if (zoomRef.current > 1 && (e.button === 1 || mode === 'hand')) {
        e.preventDefault();
        panDrag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, btn: e.button };
      }
      return;
    }
    // 가운데(휠) 버튼 = 모든 모드(커서·손바닥·글자수)에서 화면 이동(확대 상태에서만).
    // 글자수의 박스/연필/지우개로 작업하면서도 휠버튼 드래그로 패닝할 수 있게 최상단에서 처리.
    if (e.button === 1) {
      if (zoomRef.current > 1) {
        e.preventDefault();
        panDrag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, btn: e.button };
      }
      return;
    }
    // 글자수 모드 = 박스(읽을영역 채움) / 연필(칠) / 지우개(빼기). 떼는 즉시 읽지 않고 [읽기] 로 호출.
    if (mode === 'ocr') {
      if (e.button !== 0) return;
      e.preventDefault();
      const st = stageRef.current?.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const x = (e.clientX - (st?.left ?? 0)) / z;
      const y = (e.clientY - (st?.top ?? 0)) / z;
      if (ocrTool === 'pencil' || ocrTool === 'eraser') {
        pushUndoRef.current(); // 스트로크 직전 상태 저장(되돌리기).
        // 시작점에 점 하나(선분 길이 0) 찍어 클릭만으로도 칠해지게.
        const mctx = maskRef.current?.getContext('2d');
        if (mctx) {
          const lw = ((BRUSH_SCREEN_PX[brushRef.current] || 26) / z) * MASK_SS;
          paintMaskSegment(mctx, x * MASK_SS, y * MASK_SS, x * MASK_SS, y * MASK_SS, ocrTool === 'eraser' ? 'eraser' : 'pencil', lw, ocrColorRef.current);
        }
        paintRef.current = { active: true, lastX: x, lastY: y, minX: x, minY: y, maxX: x, maxY: y };
        return;
      }
      ocrDrag.current = { x0: x, y0: y, moved: false };
      return;
    }
    // 가운데(휠) 버튼 드래그 또는 손바닥 모드 = 화면 이동(팬). 확대 상태에서만.
    if (e.button === 1 || mode === 'hand') {
      if (zoomRef.current > 1) {
        e.preventDefault();
        panDrag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, btn: e.button };
      }
      return;
    }
    if (e.button !== 0) return;
    // 삭제버튼(selPin)이 열려 있으면 사진 클릭은 "삭제버튼 닫기"로만 — 새 핀은 안 만든다.
    if (selPinRef.current != null) {
      setSelPin(null);
      return;
    }
    // 입력 중인 핀이 있어도 사진의 다른 곳을 클릭/드래그하면 새 핀을 만든다(기존 핀은 입력한 만큼 유지).
    e.preventDefault();
    const st = stageRef.current?.getBoundingClientRect();
    const z = zoomRef.current || 1;
    drag.current = { ax: (e.clientX - (st?.left ?? 0)) / z, ay: (e.clientY - (st?.top ?? 0)) / z, moved: false };
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
  const commitDraft = (override?: string) => {
    if (active == null) return;
    const val = (override ?? draft).trim();
    const cur = pinsRef.current[active];
    // 규격을 막 입력했고 계산 가능한 품목코드(아크릴·포맥스·고무스카시)면 → 단가만 자동 채우고
    // 수량 단계로 진행. 수량(글자수)은 사용자가 직접 입력(품목을 줄여 쓰는 경우가 많아 자동계산 금지).
    // OCR(글자수)로 만든 핀은 수량이 이미 채워져 있어 그 단계에서 Enter 로 확인만 하면 된다.
    if (cur && FIELDS[cur.fi] === '규격') {
      const auto = computeAuto(cur.vals['품목코드'] || '', cur.vals['품목'] || '', val);
      if (auto) {
        setPins((prev) =>
          prev.map((p, i) =>
            i === active
              ? { ...p, vals: { ...p.vals, 규격: val, 단가: String(auto.unit) }, fi: p.fi + 1 }
              : p,
          ),
        );
        return;
      }
    }
    setPins((prev) => {
      const next = prev.map((p, i) => {
        if (i !== active) return p;
        // 품목 단계면 수량(글자수)도 동기(비전 자동입력 후 손 안 댄 경우만).
        const nv = FIELDS[p.fi] === '품목' ? syncQty(p.vals, val) : { ...p.vals, [FIELDS[p.fi]]: val };
        const np = { ...p, vals: nv, fi: p.fi + 1 };
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
    const p = active != null ? pins[active] : null;
    const isCode = !!p && FIELDS[p.fi] === '품목코드';
    // 품목코드 자동완성 — 드롭다운 탐색(↓↑) / 제안 적용(Enter) / 그대로(→).
    if (isCode) {
      const ms = matchCodes(draft);
      if (e.key === 'ArrowDown' && ms.length) {
        e.preventDefault();
        setAcIdx((i) => Math.min(i + 1, ms.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' && ms.length) {
        e.preventDefault();
        setAcIdx((i) => Math.max(i - 1, -1));
        return;
      }
      if (e.key === 'ArrowRight' && acIdx >= 0) {
        // 제안 무시하고 그대로 작성 — 커서가 맨 끝일 때만(중간 편집 방해 안 함).
        const el = e.target as HTMLInputElement;
        if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
          e.preventDefault();
          setAcIdx(-1);
          return;
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (acIdx >= 0 && ms[acIdx]) commitDraft(ms[acIdx]); // 하이라이트된 표준코드로
        else commitDraft(); // 그대로(강제 안 함)
        setAcIdx(-1);
        return;
      }
      if (e.key === 'Escape') {
        if (acIdx >= 0) {
          setAcIdx(-1); // 1차 Esc: 드롭다운만 닫기
          return;
        }
        closeActive();
        return;
      }
    }
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
      next[i] =
        key === '품목'
          ? { ...next[i], vals: syncQty(next[i].vals, value) } // 품목 수정 시 수량(글자수) 자동 동기
          : { ...next[i], vals: { ...next[i].vals, [key]: value } };
      return next;
    });
  };

  // 우측 명세서 표 Enter 이동 — 편집칸 품목코드(0)·품목(1)·규격(2)·수량(3)·단가(4). 공급가액=읽기전용 제외.
  // Enter 시 그 행의 다른 칸이 비어 있어도 '오른쪽으로만' 이동, 마지막(단가)에서는 다음 줄 품목코드로.
  const GRID_COLS = 5;
  const onGridKey = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    let nr = row;
    let nc = col + 1;
    if (nc >= GRID_COLS) {
      nr = row + 1;
      nc = 0;
    }
    const next = document.querySelector<HTMLInputElement>(`input[data-gr="${nr}"][data-gc="${nc}"]`);
    if (next) {
      next.focus();
      next.select();
    }
  };

  // ---- 우측 표 품목코드 자동완성(말풍선과 동일 동작) -----------------------
  const focusGridCell = (row: number, col: number) => {
    (document.querySelector(`input[data-gr="${row}"][data-gc="${col}"]`) as HTMLInputElement | null)?.focus();
  };
  // 입력칸 위치(fixed) + 초기 하이라이트(혹시-인가요면 그 항목) 잡기.
  const openGridAc = (row: number, inputEl: HTMLInputElement) => {
    const r = inputEl.getBoundingClientRect();
    const ms = matchCodes(inputEl.value);
    const dym = didYouMean(inputEl.value, ms);
    setGridAc({
      row,
      idx: dym ? ms.indexOf(dym) : -1,
      left: r.left,
      top: r.bottom,
      width: Math.max(r.width, 200),
    });
  };
  const applyGridCode = (row: number, code: string) => {
    setCell(row, '품목코드', code);
    setGridAc(null);
    setTimeout(() => focusGridCell(row, 1), 0); // 품목 칸으로
  };
  // 품목코드 칸 키 — 드롭다운 탐색(↓↑)/적용(Enter)/닫기(Esc). 선택 없으면 Enter=오른쪽 이동.
  const onGridCodeKey = (e: React.KeyboardEvent, row: number) => {
    const cur = pinsRef.current[row]?.vals['품목코드'] || '';
    const ms = matchCodes(cur);
    if (e.key === 'ArrowDown' && ms.length) {
      e.preventDefault();
      setGridAc((g) => (g ? { ...g, idx: Math.min(g.idx + 1, ms.length - 1) } : g));
      return;
    }
    if (e.key === 'ArrowUp' && ms.length) {
      e.preventDefault();
      setGridAc((g) => (g ? { ...g, idx: Math.max(g.idx - 1, -1) } : g));
      return;
    }
    if (e.key === 'Escape') {
      setGridAc(null);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = gridAc && gridAc.row === row ? gridAc.idx : -1;
      const dym = didYouMean(cur, ms);
      if (idx >= 0 && ms[idx]) {
        applyGridCode(row, ms[idx]); // 하이라이트(또는 혹시-인가요)된 표준코드 적용
      } else if (dym) {
        applyGridCode(row, dym);
      } else {
        setGridAc(null);
        focusGridCell(row, 1); // 그대로 두고 다음 칸
      }
      return;
    }
  };

  // 표의 번호 동그라미를 사진(지시서) 위로 드롭 → 그 행(핀)을 드롭 지점에 배치(제자리 말풍선). 역방향 작성.
  const onBadgeDrop = (e: React.DragEvent) => {
    if (showRef) return; // 참고사진 보기 중엔 무시 — 말풍선은 지시서에 얹는다.
    const raw = e.dataTransfer.getData('application/x-aq-pin');
    if (!raw) return;
    e.preventDefault();
    const i = parseInt(raw, 10);
    if (Number.isNaN(i)) return;
    const st = stageRef.current?.getBoundingClientRect();
    const z = zoomRef.current || 1;
    const x = (e.clientX - (st?.left ?? 0)) / z; // 화면→콘텐츠(지시서) 좌표.
    const y = (e.clientY - (st?.top ?? 0)) / z;
    // 점은 드롭 지점에, 말풍선은 점 '우상단'에(자리 없으면 좌상단). 점→말풍선 리더선(dragged).
    const off = 70 / z; // 화면상 ~70px 만큼 우상단으로
    const halfW = 180 / z; // 말풍선 화면폭(~360px)의 절반 — 우측 경계 판정용
    const dw = imgRef.current?.clientWidth ?? 0;
    let lx = x + off;
    const ly = y - off;
    if (dw && lx + halfW > dw) lx = x - off; // 우측 공간 부족 → 좌상단
    setPins((prev) => prev.map((p, idx) => (idx === i ? { ...p, ax: x, ay: y, lx, ly, dragged: true } : p)));
    setSelPin(null); // 드롭 시 삭제버튼 열지 않음 — 핀+말풍선만 생성
  };

  const total = pins.reduce((s, p) => s + (num(p.vals['단가']) || 0) * (num(p.vals['수량']) || 1), 0);

  // ---- 계산기 ----------------------------------------------------------
  // 계산기/단가찾아보기 결과를 적용할 대상. null=말풍선 active 핀 흐름, 숫자=우측 표 그 행.
  const priceTargetRef = useRef<number | null>(null);

  const applyResult = (unit: number, qty: number, desc: string) => {
    const tgt = priceTargetRef.current != null ? priceTargetRef.current : active;
    if (tgt == null) return;
    setPins((prev) =>
      prev.map((p, i) =>
        i === tgt ? { ...p, vals: { ...p.vals, 수량: String(qty), 단가: String(unit) }, fi: FIELDS.length } : p,
      ),
    );
    if (priceTargetRef.current == null) {
      setActive(null);
      setDraft('');
    }
    priceTargetRef.current = null;
    cdlg(
      `${desc}<br><b>${unit.toLocaleString()}원</b> × ${qty}자 = <b>${(unit * qty).toLocaleString()}원</b><br>` +
        `<span style="font-size:12px;color:#6b7785">수량·단가가 채워졌어요</span>`,
      [{ label: '확인' }],
    );
  };

  const splitMixed = (p: Pin, item: string, idx: number) => {
    // 한글/영문을 두 '완성' 행으로 분리. runCalc(계산)에서 호출되므로 규격은 이미 입력돼 있어
    // 각 언어 단가·수량까지 바로 계산해 채운다. 기존행=한글만, 새 행=영문만.
    const ko = item.replace(/[^가-힣\s]/g, '').replace(/\s+/g, ' ').trim();
    const en = item.replace(/[^A-Za-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const code = p.vals['품목코드'] || '';
    const spec = p.vals['규격'] || '';
    setPins((prev) => {
      const autoKo = computeAuto(code, ko, spec); // {unit, qty} | null
      const autoEn = computeAuto(code, en, spec);
      const koVals: Record<string, string> = { ...prev[idx].vals, 품목: ko };
      koVals['수량'] = String(autoKo ? autoKo.qty : charCount(ko, 'all'));
      if (autoKo) koVals['단가'] = String(autoKo.unit);
      const enVals: Record<string, string> = { 품목코드: code, 품목: en, 규격: spec };
      enVals['수량'] = String(autoEn ? autoEn.qty : charCount(en, 'all'));
      if (autoEn) enVals['단가'] = String(autoEn.unit);
      const cur: Pin = { ...prev[idx], vals: koVals, fi: FIELDS.length, splitPending: false };
      const np: Pin = {
        ax: p.ax,
        ay: p.ay,
        lx: p.lx + 18,
        ly: p.ly + (p.dragged ? 46 : 36),
        dragged: p.dragged,
        vals: enVals,
        fi: FIELDS.length, // 다 채워진 완성행 — 입력 안 열고 표/말풍선에 바로 표시
        splitPending: false,
      };
      const next = [...prev];
      next[idx] = cur;
      next.splice(idx + 1, 0, np);
      return next;
    });
    setActive(null);
    setDraft('');
  };

  const runCalc = (row?: number) => {
    const tgt = row != null ? row : active;
    if (tgt == null) return;
    priceTargetRef.current = row != null ? row : null; // 표 행이면 그 행에, 아니면 말풍선 흐름
    const p = pins[tgt];
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
          { label: '분리하기', fn: () => splitMixed(p, item, tgt) },
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
  const openLookup = async (row?: number) => {
    const tgt = row != null ? row : active;
    if (tgt == null) return;
    priceTargetRef.current = row != null ? row : null; // 표 행이면 그 행 단가에 적용
    const p = pins[tgt];
    const code = p.vals['품목코드'] || '';
    const item = p.vals['품목'] || '';
    const spec = p.vals['규격'] || '';
    const qty = p.vals['수량'] || '';
    const client = order?.clientCompanyName || '';
    setStatus('과거 단가 조회 중…');
    try {
      // 품목코드 기준 후보 리스트(①같은거래처 ②타거래처 ③관련). 한 품목→여러 후보.
      const preds = await lookupPrices(token, client, {
        text: `${code} ${item}`.trim(),
        material: code,
        size: spec,
        qty,
      });
      if (preds == null) {
        cdlg('학습 데이터(코퍼스)가 서버에 아직 없습니다. 관리자에게 R2 업로드를 요청하세요.', [{ label: '확인', sec: true }]);
        setStatus('');
        return;
      }
      // 후보별 근거(과거 지시서 사진 + 명세서 grid)를 병렬로 로드(순차면 N배 느림). 실패는 null.
      const refs: LookupRef[] = await Promise.all(
        preds.map(async (pr) => {
          let ev: Evidence | null = null;
          try {
            ev = await fetchEvidence(token, pr.ref_invoice_idx, pr.ref_file);
          } catch {
            ev = null;
          }
          return { reason: pr.reason, src: pr.src, price: pr.price, evidence: ev, hitPrice: pr.price };
        }),
      );
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
    if (priceTargetRef.current != null) {
      setCell(priceTargetRef.current, '단가', String(price)); // 우측 표 그 행 단가에 채움
      priceTargetRef.current = null;
      setLookup(null);
      return;
    }
    setDraft(String(price));
    setLookup(null);
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
  };

  // ---- 저장 (slice-12 estimate API) ------------------------------------
  const buildGrid = () => {
    const today = todayMD();
    return pins.map((p) => {
      const dp = num(p.vals['단가']);
      const qty = num(p.vals['수량']) || 1;
      const supply = dp != null ? dp * qty : null; // 공급가액 = 단가 × 수량(총액).
      return {
        월일: p.vals['월일'] || today,
        품목코드: p.vals['품목코드'] || '',
        품목: p.vals['품목'] || '',
        규격: p.vals['규격'] || '',
        수량: p.vals['수량'] || '',
        단가: p.vals['단가'] || '',
        공급가액: supply != null ? String(supply) : '',
        세액: supply != null ? String(Math.round(supply * 0.1)) : '',
        비고: p.vals['비고'] || '',
        // 핀 위치(말풍선 ax,ay / 리더선 lx,ly / 드래그여부) — 재오픈 시 원위치 복원용.
        // _ 접두사라 이지폼 셀(7키)·공유 합성과 무관(에이전트/매핑이 무시). 옛 저장본엔 없어 복원 시 폴백.
        _ax: p.ax, _ay: p.ay, _lx: p.lx, _ly: p.ly, _dragged: p.dragged,
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
      cdlg('임시저장됐어요. 주문 카드에 “임시저장” 라벨이 둘러집니다.', [{ label: '확인' }]);
    } catch (e) {
      console.error(e);
      cdlg('저장에 실패했습니다.', [{ label: '확인', sec: true }]);
    } finally {
      setSaving(false);
    }
  };

  // ---- 이지폼 자동기입 (slice-14) --------------------------------------
  // grid 를 로컬 에이전트로 보내 스테이징(arm)만 한다. 실제 기입은 사용자가 이지폼 '매출
  // 거래명세서' 새로작성 → 거래처 선택 후, 그 창에서 핫키(F6)를 눌렀을 때 에이전트가 수행.
  const [efBusy, setEfBusy] = useState(false);
  const sendToEasyform = async () => {
    if (!order) {
      cdlg('주문 컨텍스트가 없습니다. 주문 상세에서 “명세서작성”으로 들어오세요.', [{ label: '확인', sec: true }]);
      return;
    }
    const grid = buildGrid();
    const rows = gridToEasyformRows(grid);
    if (rows.length === 0) {
      cdlg('기입할 행이 없습니다. 먼저 명세서를 작성하세요.', [{ label: '확인', sec: true }]);
      return;
    }
    setEfBusy(true);
    try {
      // 이지폼 입력 = 확정 명세서. 임시저장을 안 했어도 서버(MySQL autoquote_estimate)에 저장해
      // 매출 데이터로 남긴다. 저장 실패해도 이지폼 입력은 계속(이후 markEasyformUploaded 가 완료시각).
      try {
        await putEstimate(token, order.id, { grid, total, savedFrom: 'easyform' });
        setOrder((o) => (o ? { ...o, hasEstimate: true } : o));
        onSaved?.();
      } catch (e) {
        console.error('이지폼 입력 시 명세서 저장 실패', e);
      }
      const probe = await probeEasyformAgent();
      if (!probe || !probe.easyform) {
        cdlg(
          '<b>HD사인지시서(사무용)</b> 또는 <b>명세서 자동작성</b> 프로그램이 켜져 있지 않습니다.<br>' +
            '아래 중 하나를 실행한 뒤 다시 시도해주세요.' +
            '<div style="display:flex;gap:24px;justify-content:center;margin:18px 0 6px">' +
            '<div style="text-align:center;width:104px">' +
            '<div style="width:54px;height:54px;border-radius:13px;background:#0a9396;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto">🖥️</div>' +
            '<div style="font-size:11.5px;font-weight:700;margin-top:7px;line-height:1.3">HD사인지시서<br>(사무용)</div>' +
            '</div>' +
            '<div style="text-align:center;width:104px">' +
            '<div style="width:54px;height:54px;border-radius:13px;background:#F57C00;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto">📝</div>' +
            '<div style="font-size:11.5px;font-weight:700;margin-top:7px;color:#F57C00;line-height:1.3">명세서 자동작성</div>' +
            '<a href="/hdsign_easyform_agent.exe" download="명세서자동작성.exe" ' +
            'style="display:inline-block;margin-top:6px;font-size:11.5px;color:#fff;background:#F57C00;padding:3px 11px;border-radius:6px;font-weight:700;text-decoration:none">다운로드 ↓</a>' +
            '</div></div>' +
            '<div style="font-size:11px;color:#6b7785;margin-top:8px">둘 중 하나만 켜져 있으면 됩니다. 프로그램이 없으면 위 주황(명세서 자동작성)에서 받으세요.</div>',
          [{ label: '확인', sec: true }],
        );
        return;
      }
      const res = await fillEasyform(rows);
      if (!res.staged) {
        cdlg(res.message || '이지폼으로 보내지 못했습니다.', [{ label: '확인', sec: true }]);
        return;
      }
      // 스테이징 성공 → '명세서작성완료' 배지 점등(이지폼으로 보냄). 별도 [기입 완료] 단계 제거.
      markEasyformUploaded(token, order.id)
        .then(() => {
          setOrder((o) => (o ? { ...o, easyformUploadedAt: new Date().toISOString() } : o));
          onSaved?.();
          onEasyformUploaded?.(); // 목록 카드 '명세서작성완료' 배지 즉시 점등(작업중·작업완료 양쪽)
        })
        .catch((e) => console.error(e));
      cdlg(
        `이지폼 <b>매출 거래명세서 → 새로작성 → 거래처 선택</b> 후,<br>` +
          `<b>'이지폼 자동기입 시작하기 ▶'</b> 를 눌러주세요.`,
        [{ label: '닫기', sec: true }],
      );
    } catch (e) {
      console.error(e);
      cdlg('이지폼 전송에 실패했습니다.', [{ label: '확인', sec: true }]);
    } finally {
      setEfBusy(false);
    }
  };

  // ---- 공유 (Canvas 합성 → 클립보드) ------------------------------------
  // 참고사진이 있으면 포함 여부를 먼저 묻는다. 포함 시 2장(① 지시서+말풍선+명세서, ② 참고사진)으로 저장.
  const captureShare = () => {
    if (refSrc) {
      cdlg('참고사진도 함께 공유할까요?', [
        { label: '참고사진 포함', fn: () => doShare(true) },
        { label: '지시서+명세서만', fn: () => doShare(false), sec: true },
      ]);
    } else {
      doShare(false);
    }
  };

  const doShare = (includeRef: boolean) => {
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

    // ── 오른쪽 명세서(표) 메트릭 — 표 너비가 사진 너비의 약 2/3 가 되도록 글자 크기를 정한다.
    //    (사진:표 ≈ 3:2 — 작성 화면 비율. 예전엔 nh/42·상한40 이라 고해상 사진에서 표가 너무 작았음.) ──
    const colSpec: { key: string; label: string; m: number; align: 'left' | 'center' | 'right' }[] = [
      { key: '번호', label: '', m: 2.0, align: 'center' },
      { key: '품목코드', label: '품목코드', m: 4.6, align: 'left' },
      { key: '품목', label: '품목', m: 12, align: 'left' },
      { key: '규격', label: '규격', m: 4.4, align: 'left' },
      { key: '수량', label: '수량', m: 3.0, align: 'right' },
      { key: '단가', label: '단가', m: 5.6, align: 'right' },
      { key: '공급가액', label: '공급가액', m: 6.4, align: 'right' },
    ];
    const mSum = colSpec.reduce((s, c) => s + c.m, 0) + 1.2; // 열 가중치 합 + 좌우 패딩(tfs*0.6*2)
    const tfs = Math.max(22, Math.round((nw * (2 / 3)) / mSum)); // 표폭 ≈ 사진폭 × 2/3
    const cols = colSpec.map((c) => ({ key: c.key, label: c.label, w: tfs * c.m, align: c.align }));
    const tpad = tfs * 0.6;
    const tw = cols.reduce((s, c) => s + c.w, 0) + tpad * 2;
    const titleH = tfs * 2.6,
      headH = tfs * 2.1,
      rh = tfs * 2.0,
      footH = tfs * 2.8;
    const nRows = Math.max(pins.length, 1);
    const th = titleH + headH + rh * nRows + footH;

    const GAP = Math.round(tfs * 0.8);
    const cv = document.createElement('canvas');
    cv.width = nw + GAP + tw;
    cv.height = Math.max(nh, th);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // ── 왼쪽: 사진 + 말풍선 (기존 합성) ──────────────────────────────
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
        bx = lx - w / 2; // 리더선이 말풍선 정중앙에 닿도록 박스를 드롭 지점 중앙에.
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
      // 말풍선이 사진 우측을 넘으면 안쪽으로 당겨 그린다(표 영역 침범 방지 — cv.width 아닌 사진폭 nw 기준).
      if (bx + w > nw - 2) bx = nw - w - 2;
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

    // ── 오른쪽: 명세서 표 (화면의 grid 를 캔버스로 재현) ──────────────
    const ox = nw + GAP;
    const cellText = (p: Pin, key: string): string => {
      const v = p.vals;
      if (key === '공급가액') {
        const u = num(v['단가']);
        return u == null ? '' : (u * (num(v['수량']) || 1)).toLocaleString();
      }
      if (key === '단가') {
        const u = num(v['단가']);
        return u == null ? '' : u.toLocaleString();
      }
      return v[key] || '';
    };
    // 셀 폭을 넘는 글자는 … 로 줄인다.
    const fitText = (text: string, maxW: number): string => {
      let t = String(text);
      if (ctx.measureText(t).width <= maxW) return t;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    };
    const cellX = (col: (typeof cols)[number], left: number): number =>
      col.align === 'right' ? left + col.w - tfs * 0.35 : col.align === 'center' ? left + col.w / 2 : left + tfs * 0.35;

    ctx.textBaseline = 'middle';
    // 제목 줄 — "견적" + 거래처.
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'left';
    ctx.font = '800 ' + Math.round(tfs * 1.15) + 'px sans-serif';
    ctx.fillText('견적', ox + tpad, titleH / 2);
    const tag = order ? order.clientCompanyName || order.orderNumber || '' : '';
    if (tag) {
      ctx.textAlign = 'right';
      ctx.font = '600 ' + Math.round(tfs * 0.92) + 'px sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText(fitText(String(tag), tw * 0.5), ox + tw - tpad, titleH / 2);
    }
    // 헤더 줄.
    let ty = titleH;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(ox, ty, tw, headH);
    ctx.fillStyle = '#334155';
    ctx.font = '700 ' + Math.round(tfs * 0.9) + 'px sans-serif';
    {
      let cx = ox + tpad;
      for (const col of cols) {
        if (col.label) {
          ctx.textAlign = col.align;
          ctx.fillText(col.label, cellX(col, cx), ty + headH / 2);
        }
        cx += col.w;
      }
    }
    ty += headH;
    // 데이터 행.
    pins.forEach((p, i) => {
      const rowY = ty + rh * i;
      const my = rowY + rh / 2;
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox, rowY + rh);
      ctx.lineTo(ox + tw, rowY + rh);
      ctx.stroke();
      // 번호 배지(핀 색).
      const c = pinColor(i);
      const bcx = ox + tpad + cols[0].w / 2;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(bcx, my, tfs * 0.62, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '700 ' + Math.round(tfs * 0.8) + 'px sans-serif';
      ctx.fillText(String(i + 1), bcx, my);
      // 셀 값.
      ctx.fillStyle = '#1e293b';
      ctx.font = Math.round(tfs * 0.96) + 'px sans-serif';
      let cx = ox + tpad + cols[0].w;
      for (let k = 1; k < cols.length; k++) {
        const col = cols[k];
        const raw = cellText(p, col.key);
        if (raw) {
          ctx.textAlign = col.align;
          ctx.fillText(fitText(raw, col.w - tfs * 0.7), cellX(col, cx), my);
        }
        cx += col.w;
      }
    });
    ty += rh * nRows;
    // 합계 줄.
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(ox, ty, tw, footH);
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'left';
    ctx.font = '700 ' + Math.round(tfs) + 'px sans-serif';
    ctx.fillText('합계', ox + tpad, ty + footH / 2);
    ctx.textAlign = 'right';
    ctx.font = '800 ' + Math.round(tfs * 1.1) + 'px sans-serif';
    ctx.fillText(total.toLocaleString() + '원', ox + tw - tpad, ty + footH / 2);
    // 표 외곽선.
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + 0.5, 0.5, tw - 1, th - 1);
    ctx.textAlign = 'left';

    const dlBlob = (b: Blob, name: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    cv.toBlob(async (blob) => {
      if (!blob) {
        cdlg('캡쳐 실패(샘플 이미지는 보안제한 — 붙여넣은 사진으로 시도하세요).', [{ label: '확인', sec: true }]);
        return;
      }
      // 참고사진 포함 — 클립보드는 1장만 가능하므로 두 장 모두 파일로 저장(① 합성, ② 참고사진).
      if (includeRef && refSrc) {
        dlBlob(blob, '지시서_명세서.png');
        try {
          const rb = await (await fetch(refSrc)).blob();
          dlBlob(rb, '참고사진.png');
        } catch {
          /* 참고사진 저장 실패는 합성 저장엔 영향 없음 */
        }
        cdlg('2장(지시서+명세서 · 참고사진)을 저장했어요. 카톡에 두 장 모두 첨부하세요.', [{ label: '확인' }]);
        return;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        cdlg('✅ 작업지시서+명세서가 복사됐어요! 📋 카톡에서 Ctrl+V 로 붙여넣어주세요.', [{ label: '확인' }]);
      } catch {
        dlBlob(blob, '견적.png');
        cdlg('클립보드 복사가 막혀 이미지로 저장했어요.', [{ label: '확인' }]);
      }
    }, 'image/png');
  };

  // ---- 글자수(OCR) — 마스크로 칠한 영역만 크롭해 vision 으로 글자/글자수 -------
  // 박스/연필로 칠한 keep-mask 영역만 원본 해상도로 잘라 base64 → /vision(read_text).
  // 읽은 글자를 활성/선택 말풍선의 품목 칸에 자동 입력하면 기존 계산기가 charCount 로 글자수(=수량)를 센다.

  /** 마스크 캔버스를 비운다(읽기 완료/지우기 버튼). */
  // 현재 마스크 상태를 되돌리기 스택에 저장(그리기/박스/지우기 직전 호출). 우리 캔버스라 taint 없음.
  const pushUndo = () => {
    const m = maskRef.current;
    if (!m || m.width === 0) return;
    try {
      undoRef.current.push(m.toDataURL('image/png'));
      if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
      setCanUndo(true);
    } catch {
      /* 무시 */
    }
  };
  pushUndoRef.current = pushUndo;

  // 직전 상태로 되돌린다(연필/지우개/박스/✕ 한 단계씩). 복원은 비동기(Image 디코드).
  const undoMask = () => {
    const m = maskRef.current;
    const mctx = m?.getContext('2d');
    if (!m || !mctx) return;
    const prev = undoRef.current.pop();
    setCanUndo(undoRef.current.length > 0);
    if (prev === undefined) {
      // 더 되돌릴 게 없으면 비운다.
      mctx.clearRect(0, 0, m.width, m.height);
      setMaskHasInk(false);
      return;
    }
    const img = new Image();
    img.onload = () => {
      mctx.clearRect(0, 0, m.width, m.height);
      mctx.drawImage(img, 0, 0, m.width, m.height);
      setMaskHasInk(maskHasAnyInk(m));
    };
    img.src = prev;
  };
  undoMaskRef.current = undoMask;

  // ✕ — 칠한 것 전부 지우기(되돌리기 가능하게 직전 상태 저장).
  const clearMask = () => {
    const m = maskRef.current;
    if (!m) return;
    pushUndo();
    m.getContext('2d')?.clearRect(0, 0, m.width, m.height);
    firstAnchorRef.current = null;
    setMaskHasInk(false);
  };

  // 읽기 완료 후 — 마스크와 되돌리기 스택을 함께 비운다(읽기 너머로는 undo 안 함).
  const resetMaskAndUndo = () => {
    const m = maskRef.current;
    if (m) m.getContext('2d')?.clearRect(0, 0, m.width, m.height);
    undoRef.current = [];
    firstAnchorRef.current = null;
    setCanUndo(false);
    setMaskHasInk(false);
  };

  // 읽은 글자 → 칠한 자리(anchor)에 새 말풍선 생성. 품목코드(fi=0)부터 입력 포커스, 품목엔 읽은
  // 글자가 미리 채워져 있어(prefill effect) Enter 로 품목 단계에 가면 바로 수정·확정 가능.
  const createPinFromOcr = (anchor: { x: number; y: number }, text: string) => {
    const ax = anchor.x;
    const ay = anchor.y;
    const qty = charCount(text, 'all'); // 글자수(공백 제외) = 수량.
    setPins((prev) => {
      // 점=영역 중앙, 말풍선=우상단으로 살짝 비켜 리더선 연결(주변에 생성).
      // 품목=읽은 글자, 수량=글자수(둘 다 prefill — 단계 진행 시 입력칸에 채워져 나옴).
      const next = [
        ...prev,
        { ax, ay, lx: ax + 36, ly: ay - 28, dragged: true, vals: { 품목: ocrTruncItem(text), 수량: String(qty) }, fi: 0 },
      ];
      setActive(next.length - 1);
      return next;
    });
    setSelPin(null);
    setSelectedPin(null);
  };

  /**
   * 크롭된 출력 캔버스(소스 영역 그려진 상태)에 마스크 화이트아웃을 적용하고, 흑백+대비 전처리 후
   * Haiku 로 보낸다. maskAlpha(출력 크기) 가 32 미만인 픽셀은 흰색으로 덮어 잡음을 제거한다.
   */
  const preprocessAndSend = (cv: HTMLCanvasElement, maskAlpha: Uint8ClampedArray | null) => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const ow = cv.width;
    const oh = cv.height;
    let dataUrl: string;
    try {
      // (CORS taint 면 getImageData 가 SecurityError 를 던져 catch 로 → 동일 안내.)
      const idata = ctx.getImageData(0, 0, ow, oh);
      const d = idata.data;
      const n = ow * oh;
      // 마스크 밖(칠 안 한 곳)은 흰색으로 — 읽을 글자만 남긴다.
      if (maskAlpha) {
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          if (maskAlpha[i] < 32) {
            d[p] = 255;
            d[p + 1] = 255;
            d[p + 2] = 255;
          }
        }
      }
      // 전처리 — 연한/저대비 글자도 Haiku 가 읽게: 흑백 변환 + 2~98% 퍼센타일 대비 스트레칭 + 가벼운 감마.
      const hist = new Uint32Array(256);
      const lum = new Uint8ClampedArray(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const L = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
        lum[i] = L;
        hist[L]++;
      }
      const loCut = n * 0.02;
      const hiCut = n * 0.98;
      let acc = 0;
      let lo = 0;
      let hi = 255;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= loCut) { lo = v; break; }
      }
      acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= hiCut) { hi = v; break; }
      }
      const span = hi - lo;
      const gamma = 1.15; // >1 → 중간톤을 어둡게: 얇고 연한 획을 검정 쪽으로.
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let t = span > 4 ? (v - lo) / span : v / 255; // 거의 평탄하면 스트레칭 생략(흑백만).
        t = Math.min(1, Math.max(0, t));
        lut[v] = Math.round(Math.pow(t, gamma) * 255);
      }
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const o = lut[lum[i]];
        d[p] = o;
        d[p + 1] = o;
        d[p + 2] = o;
      }
      ctx.putImageData(idata, 0, 0);
      dataUrl = cv.toDataURL('image/png'); // 무손실 — 고대비 가장자리를 JPEG 압축으로 뭉개지 않게.
    } catch {
      cdlg(
        '이 지시서 이미지는 보안 제한(CORS)으로 잘라낼 수 없어요.<br>붙여넣기(Ctrl+V)했거나 PDF로 불러온 지시서에서 사용하세요.',
        [{ label: '확인', sec: true }],
      );
      return;
    }
    setOcrBusy(true);
    setStatus('글자 읽는 중…');
    // 앵커는 비우기 전에 캡처(finally 가 firstAnchorRef 를 null 로 만든다).
    const anchor = firstAnchorRef.current ?? { x: 30, y: 30 };
    readText(token, dataUrl, 'image/png')
      .then((r) => {
        if (r.quota) setVisionQuota(r.quota); // 버튼 옆 '오늘 남은 횟수' 갱신
        const text = (r.text || '').trim();
        setStatus('');
        if (!text) {
          cdlg('이 영역에서 글자를 못 읽었어요. 읽을 부분을 더 크게/정확히 칠해보세요.', [{ label: '확인', sec: true }]);
          return;
        }
        const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] || c);
        const newIdx = pinsRef.current.length; // 새로 만들어질 말풍선 번호(0-based).
        const circle =
          `<span style="display:inline-flex;width:22px;height:22px;border-radius:50%;` +
          `background:${pinColor(newIdx)};color:#fff;font-weight:800;font-size:12px;` +
          `align-items:center;justify-content:center;vertical-align:middle;margin-right:5px">${newIdx + 1}</span>`;
        cdlg(
          `<div style="margin-bottom:7px;font-size:14px">${circle}<b>번 품목으로 추가할까요?</b></div>` +
            `<b style="font-size:15px">"${esc}"</b>` +
            `<div style="font-size:11.5px;color:#6b7785;margin-top:6px">추후에 수정 가능합니다.</div>`,
          [
            { label: '확인', fn: () => createPinFromOcr(anchor, text) },
            { label: '취소', sec: true },
          ],
        );
      })
      .catch((e) => {
        console.error(e);
        setStatus('');
        if (e instanceof DailyLimitError) {
          setVisionQuota((q) => (q ? { ...q, used: q.limit, remaining: 0 } : (e.quota ?? null)));
          cdlg(
            `일일 한도 ${e.quota?.limit ?? visionQuota?.limit ?? 100}회가 모두 소진되었습니다.<br>관리자(현우)에게 문의하세요.`,
            [{ label: '확인', sec: true }],
          );
          return;
        }
        cdlg('글자읽기에 실패했어요. 잠시 후 다시 시도해 주세요.', [{ label: '확인', sec: true }]);
      })
      .finally(() => {
        setOcrBusy(false);
        resetMaskAndUndo(); // 읽고 나면 마스크·되돌리기 스택을 비워 다음 영역을 새로.
      });
  };

  /** [읽기] / Enter — 마스크의 칠한 영역(bbox) 만 잘라 화이트아웃 후 OCR 호출. */
  const readMask = () => {
    // 일일 한도 소진 시 호출 전에 차단(서버도 막지만 헛호출 방지).
    if (visionQuota && visionQuota.remaining <= 0) {
      cdlg(
        `일일 한도 ${visionQuota.limit}회가 모두 소진되었습니다.<br>관리자(현우)에게 문의하세요.`,
        [{ label: '확인', sec: true }],
      );
      return;
    }
    const img = imgRef.current;
    const mask = maskRef.current;
    if (!img || !imgSrc || !mask) return;
    const mw = mask.width;
    const mh = mask.height;
    const mctx = mask.getContext('2d');
    if (!mctx || mw === 0 || mh === 0) return;
    // 칠한(알파>32) 픽셀의 bbox 계산.
    const md = mctx.getImageData(0, 0, mw, mh).data;
    let minX = mw;
    let minY = mh;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (md[(y * mw + x) * 4 + 3] > 32) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      cdlg('읽을 영역을 먼저 칠하세요. (박스 또는 연필)', [{ label: '확인', sec: true }]);
      return;
    }
    const pad = 6 * MASK_SS; // 글자 가장자리가 잘리지 않게 약간 여유(백킹 px 기준 = 콘텐츠 6px).
    const bx = Math.max(0, minX - pad);
    const by = Math.max(0, minY - pad);
    const bw = Math.min(mw, maxX + 1 + pad) - bx;
    const bh = Math.min(mh, maxY + 1 + pad) - by;
    // 첫 영역 앵커가 없으면(방어) 전체 마스크 bbox 중앙을 앵커로(콘텐츠 좌표).
    if (!firstAnchorRef.current) {
      firstAnchorRef.current = { x: (bx + bw / 2) / MASK_SS, y: (by + bh / 2) / MASK_SS };
    }
    // bx..bh 는 마스크 백킹 px(=콘텐츠 px × MASK_SS). 소스 매핑은 콘텐츠로 환산(÷MASK_SS) 후 ×sx.
    const sx = img.naturalWidth / (img.clientWidth || 1);
    const sy = img.naturalHeight / (img.clientHeight || 1);
    const srcX = (bx / MASK_SS) * sx;
    const srcY = (by / MASK_SS) * sy;
    const srcW = (bw / MASK_SS) * sx;
    const srcH = (bh / MASK_SS) * sy;
    // 출력 크기: Claude 이미지는 ~1.15MP(긴 변 ~1568px)로 다운스케일 → 그 위는 토큰 낭비.
    // 작은 영역은 ~900px 까지만 키워 얇은 획에 픽셀을 더 준다(상한 1568, 과확대 뭉개짐 방지).
    const longNative = Math.max(srcW, srcH);
    const targetLong = Math.min(1568, Math.max(longNative, 900));
    const k = targetLong / longNative;
    const ow = Math.max(1, Math.round(srcW * k));
    const oh = Math.max(1, Math.round(srcH * k));
    // 1) 소스 고해상에서 bbox 크롭.
    const cv = document.createElement('canvas');
    cv.width = ow;
    cv.height = oh;
    const cctx = cv.getContext('2d');
    if (!cctx) return;
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, ow, oh);
    cctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, ow, oh);
    // 2) 마스크 bbox 를 출력 크기로 스케일해 알파 추출(우리가 그린 캔버스라 taint 없음).
    const mt = document.createElement('canvas');
    mt.width = ow;
    mt.height = oh;
    const mtctx = mt.getContext('2d');
    if (!mtctx) return;
    mtctx.drawImage(mask, bx, by, bw, bh, 0, 0, ow, oh);
    const ma = mtctx.getImageData(0, 0, ow, oh).data;
    const maskAlpha = new Uint8ClampedArray(ow * oh);
    for (let i = 0; i < ow * oh; i++) maskAlpha[i] = ma[i * 4 + 3];
    // 3) 화이트아웃 + 전처리 + 전송.
    preprocessAndSend(cv, maskAlpha);
  };
  performOcrRef.current = readMask;

  // ---- 렌더 ------------------------------------------------------------
  // 글자수·말풍선 모드에선 다음에 만들어질 행(빈 칸)이 보이도록 한 줄 더 + 그 행을 하이라이트.
  // 단, 어떤 행을 편집 중(active≠null)이면 그 행을 다 채우는 중이므로 다음 행은 칠하지 않는다.
  // → 현재 행 입력을 마쳐 active 가 풀리고 모드(2·3)가 유지될 때 비로소 다음 행이 칠해진다.
  const ocrTarget = pins.length; // 읽으면/그리면 새로 만들어질 말풍선·행 번호(0-based).
  // 다음 항목 행 하이라이트(글자수=3 · 말풍선=2 공통). 핀 편집 중(active)이나 우측 표를 수기
  // 편집 중(gridEditing)이면 끈다 — 표에서 n번 행 작성 중에 n+1 행이 미리 칠해지던 문제 방지.
  const showTgtRow = (mode === 'ocr' || mode === 'cursor') && active === null && !gridEditing;
  const rows = Math.max(ROWS, pins.length + (showTgtRow ? 1 : 0));
  // 박스·연필·커서·grid 행 하이라이트 색 = 다음 말풍선 색. "지금 칠하는 게 N번으로 들어가겠구나".
  const ocrColor = pinColor(ocrTarget);
  ocrColorRef.current = ocrColor;
  // 글자수 모드 커서: 연필·지우개는 브러시 지름만 한 원, 박스는 십자.
  const ocrCursor =
    mode === 'ocr'
      ? ocrTool === 'pencil' || ocrTool === 'eraser'
        ? brushCursor(BRUSH_SCREEN_PX[brush], ocrTool, ocrColor)
        : 'crosshair'
      : undefined;

  return (
    <div className="aq-root">
      <div className="aq-bar">
        <b>자동견적</b>
        <span className="aq-hint">{status}</span>
        <span className="aq-sp" />
        {imgSrc && <span className="aq-hint" style={{ marginRight: 4 }}>휠로 확대 · {Math.round(zoom * 100)}%</span>}
        {zoom !== 1 && (
          <button
            className="aq-x"
            title="원래 크기"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            ⤢
          </button>
        )}
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
        <div
          className={`aq-stagewrap${mode === 'hand' ? ' aq-hand' : ''}${mode === 'ocr' ? ' aq-ocr' : ''}`}
          ref={stagewrapRef}
          onMouseDown={startStageDrag}
        >
          {/* 참고사진이 있으면 사진 좌·우 화살표로 [작업지시서 ↔ 참고사진] 넘김(2장 캐러셀). */}
          {imgSrc && refSrc && (
            <>
              <button
                type="button"
                className="aq-navarrow left"
                title="이전 사진 (작업지시서 ↔ 참고사진)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowRef((v) => !v)}
              >
                ‹
              </button>
              <button
                type="button"
                className="aq-navarrow right"
                title="다음 사진 (작업지시서 ↔ 참고사진)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowRef((v) => !v)}
              >
                ›
              </button>
              <div className="aq-navlabel" onMouseDown={(e) => e.stopPropagation()}>
                {showRef ? '참고사진 (2/2)' : '작업지시서 (1/2)'}
              </div>
            </>
          )}
          {imgSrc && !showRef && (
            <div className="aq-tools">
              <button
                type="button"
                className={'aq-toolbtn' + (mode === 'hand' ? ' on' : '')}
                title="지시서 이동 — 드래그로 사진 이동(확대 시) (단축키 1)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setMode('hand')}
              >
                <svg viewBox="0 0 512 512" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <path d="M352.2 425.8l-79.2 79.2c-9.4 9.4-24.6 9.4-33.9 0l-79.2-79.2c-15.1-15.1-4.4-41 17-41h51.2V284H127.2v51.2c0 21.4-25.9 32.1-41 17L7 272.9c-9.4-9.4-9.4-24.6 0-33.9L86.2 159.8c15.1-15.1 41-4.4 41 17V228H228V127.2h-51.2c-21.4 0-32.1-25.9-17-41L239 7c9.4-9.4 24.6-9.4 33.9 0l79.2 79.2c15.1 15.1 4.4 41-17 41h-51.2V228h100.8v-51.2c0-21.4 25.9-32.1 41-17l79.2 79.2c9.4 9.4 9.4 24.6 0 33.9l-79.2 79.2c-15.1 15.1-41 4.4-41-17V284H284v100.8h51.2c21.4 0 32.1 25.9 17 41z" />
                </svg>
              </button>
              <button
                type="button"
                className={'aq-toolbtn' + (mode === 'cursor' ? ' on' : '')}
                title="말풍선 — 드래그로 말풍선 작성 (단축키 2)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setMode('cursor')}
              >
                <svg viewBox="0 0 512 512" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <path d="M256 32C114.6 32 0 125.1 0 240c0 49.6 21.4 95 57 130.7C44.5 421.1 2.7 466 2.2 466.5c-2.2 2.3-2.8 5.7-1.5 8.7 1.3 3 4.3 4.9 7.5 4.8 66.3 0 116-31.8 140.6-51.4 32.7 12.3 69 19.4 106.4 19.4 141.4 0 256-93.1 256-208S397.4 32 256 32z" />
                </svg>
              </button>
              <button
                type="button"
                className={'aq-toolbtn aq-ocrbtn' + (mode === 'ocr' ? ' on' : '')}
                title="글자AI — 박스/연필로 읽을 글자만 칠한 뒤 AI가 읽어 글자수를 세요 (단축키 3). 글자수 모드에서 또 누르면 박스→연필→지우개 순환"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() =>
                  // 키 3 과 동일: 글자수 모드가 아니면 진입, 이미면 박스→연필→지우개 순환.
                  modeRef.current === 'ocr'
                    ? setOcrTool((t) => (t === 'box' ? 'pencil' : t === 'pencil' ? 'eraser' : 'box'))
                    : setMode('ocr')
                }
              >
                글자AI
              </button>
              {visionQuota && (
                <span
                  className="aq-ocrquota"
                  title="글자AI 일일 한도(전체 공용). 자정(KST) 리셋."
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    color: visionQuota.remaining <= 0 ? '#dc2626' : visionQuota.remaining <= 10 ? '#d97706' : '#6b7785',
                  }}
                >
                  오늘 남은 횟수: {visionQuota.remaining}/{visionQuota.limit}
                </span>
              )}
            </div>
          )}
          {imgSrc && !showRef && mode === 'ocr' && (
            <div className="aq-ocrtools" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={'aq-octbtn' + (ocrTool === 'box' ? ' on' : '')}
                title="박스 — 사각 영역을 읽을 영역으로 채움"
                onClick={() => setOcrTool('box')}
              >
                ▭ 박스
              </button>
              <button
                type="button"
                className={'aq-octbtn' + (ocrTool === 'pencil' ? ' on' : '')}
                title="연필 — 읽을 글자를 칠해서 추가"
                onClick={() => setOcrTool('pencil')}
              >
                ✏️ 연필
              </button>
              <button
                type="button"
                className={'aq-octbtn' + (ocrTool === 'eraser' ? ' on' : '')}
                title="지우개 — 칠한 영역에서 빼기"
                onClick={() => setOcrTool('eraser')}
              >
                🧽 지우개
              </button>
              {(ocrTool === 'pencil' || ocrTool === 'eraser') && (
                <span className="aq-octsize">
                  {(['s', 'm', 'l'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={'aq-octszbtn' + (brush === s ? ' on' : '')}
                      title={`${s === 's' ? '작은' : s === 'm' ? '중간' : '큰'} 원`}
                      onClick={() => setBrush(s)}
                    >
                      <span className="aq-octdot" style={{ width: BRUSH_DOT_PX[s], height: BRUSH_DOT_PX[s] }} />
                    </button>
                  ))}
                </span>
              )}
              <span className="aq-octsp" />
              <button
                type="button"
                className="aq-octbtn"
                disabled={!canUndo || ocrBusy}
                title="되돌리기 — 방금 그린 박스/연필/지우개 취소 (Ctrl+Z)"
                onClick={() => undoMaskRef.current()}
              >
                ↶ 되돌리기
              </button>
            </div>
          )}
          {/* 읽기(✓)/전체지우기(✕) — 지시서 상단 중앙 고정. 화면 이동/확대해도 따라다닌다. */}
          {imgSrc && !showRef && mode === 'ocr' && (
            <div className="aq-ocrconfirm" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="aq-ocrok"
                disabled={!maskHasInk || ocrBusy}
                title="칠한 영역의 글자를 한꺼번에 읽기 (Enter)"
                onClick={() => performOcrRef.current()}
              >
                ✓
              </button>
              <button
                type="button"
                className="aq-ocrclear"
                disabled={!maskHasInk || ocrBusy}
                title="칠한 영역 모두 지우기"
                onClick={clearMask}
              >
                ✕
              </button>
            </div>
          )}
          {imgSrc && !showRef && mode === 'ocr' && !ocrBusy && (
            <div className="aq-ocrhint">
              {`${ocrTarget + 1}번 항목 — 박스/연필로 칠한 뒤 위 ✓ 누르면 그 자리에 말풍선이 생겨요`}
            </div>
          )}
          {ocrBusy && !showRef && <div className="aq-ocrbusy">글자 읽는 중…</div>}
          {!imgSrc ? (
            loadingImg ? (
              <div className="aq-empty">
                ⏳
                <br />
                지시서 로딩중입니다
              </div>
            ) : (
              <div className="aq-empty">
                📋
                <br />
                작업지시서 이미지를 붙여넣으세요
                <br />
                <span style={{ fontSize: 12 }}>Ctrl + V</span>
              </div>
            )
          ) : (
            <div
              className="aq-stage"
              ref={stageRef}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
              onDragOver={(e) => {
                if (!showRef) e.preventDefault(); // 번호 동그라미 드롭 허용(지시서 보기 중에만).
              }}
              onDrop={onBadgeDrop}
            >
              {/* crossOrigin 미설정 — R2 공개 URL 이 CORS 헤더를 안 줘서 anonymous 면 이미지가 깨진다.
                  로드 우선. 공유 캔버스가 taint 로 막히면 PNG 다운로드로 폴백한다. */}
              <img
                ref={imgRef}
                src={imgSrc}
                alt="작업지시서"
                onLoad={() => {
                  setStageW(imgRef.current?.clientWidth || 0);
                  setStageH(imgRef.current?.clientHeight || 0);
                }}
                draggable={false}
                style={{ ...(ocrCursor ? { cursor: ocrCursor } : {}), visibility: showRef ? 'hidden' : 'visible' }}
              />
              {/* 참고사진 보기 — 지시서 박스 안에 겹쳐 표시(보기 전용, 말풍선 없음). */}
              {showRef && refSrc && <img className="aq-refimg" src={refSrc} alt="참고사진" draggable={false} />}
              {/* 지시서 오버레이(마스크·리더선·핀·말풍선)는 참고사진 볼 땐 숨긴다. */}
              {!showRef && (
                <>
              {/* 글자수 마스크 — 읽을 영역 색칠(알파=keep-mask). 콘텐츠 해상도, stage 스케일을 함께 탄다. */}
              <canvas ref={maskRef} className="aq-ocrmask" style={{ width: stageW, height: stageH }} />
              {/* SVG stroke 은 sub-pixel 허용(CSS border 의 1px 클램프 없음)이라 strokeWidth=폭/zoom 으로
                  확대해도 화면상 일정한 얇은 선이 된다. (vector-effect 는 조상 CSS transform 엔 안 먹어서 미사용.) */}
              <svg className="aq-lines">
                {pins.map((p, i) =>
                  p.dragged ? (
                    <line key={i} x1={p.ax} y1={p.ay} x2={p.lx} y2={p.ly} stroke={pinColor(i)} strokeWidth={2 / zoom} />
                  ) : null,
                )}
                {ghost && (
                  <line
                    x1={ghost.ax}
                    y1={ghost.ay}
                    x2={ghost.x}
                    y2={ghost.y}
                    stroke="#0a9396"
                    strokeWidth={2 / zoom}
                    strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                  />
                )}
                {/* 글자수 선택 박스 — 정지 점선. 폭·점선 간격을 /zoom 해서 확대해도 얇고 일정. */}
                {ocrSel && (
                  <rect
                    x={ocrSel.x}
                    y={ocrSel.y}
                    width={ocrSel.w}
                    height={ocrSel.h}
                    fill={hexToRgba(ocrColor, 0.14)}
                    stroke={ocrColor}
                    strokeWidth={1.5 / zoom}
                    strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                  />
                )}
              </svg>

              {/* 핀 점 */}
              {pins.map((p, i) => (
                <div
                  key={'dot' + i}
                  className="aq-dot"
                  style={{
                    left: p.ax - 10.5 / zoom,
                    top: p.ay - 10.5 / zoom,
                    background: pinColor(i),
                    transform: `scale(${1 / zoom})`,
                    transformOrigin: '0 0',
                  }}
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
                  style={{
                    left: pins[selPin].ax + 14 / zoom,
                    top: pins[selPin].ay - 16 / zoom,
                    transform: `scale(${1 / zoom})`,
                    transformOrigin: '0 0',
                  }}
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
                // 수기(표) 핀은 처음엔 점만 — 말풍선 숨김. 점을 드래그해 놓으면 dragged=true 가 되며 펼쳐진다.
                if (!p.dragged && !isActive) return null;
                // 입력 중에는 현재 필드명만 안내. 끝나면 2줄: (위) 품목 규격, (아래) 단가원 ×수량개 = 합계원.
                const top = [p.vals['품목'] ? `"${p.vals['품목']}"` : '', p.vals['규격']].filter(Boolean).join(' ');
                const dp = num(p.vals['단가']);
                const qty = num(p.vals['수량']) || 1;
                const priceLine =
                  dp != null ? `${dp.toLocaleString()}원 ×${qty}개 = ${(dp * qty).toLocaleString()}원` : '';
                const hasContent = !!(top || priceLine);
                // 말풍선은 확대해도 원래 크기 유지(scale 1/zoom). 드롭 지점에 코너를 붙이고,
                // 사진 경계를 넘치면 그 코너 기준으로 뒤집어(우→좌, 아래→위) 화면 안에 들어오게 한다.
                // 박스가 차지하는 화면폭(~360px)을 zoom 으로 나눈 만큼이 콘텐츠 폭 — 그것으로 경계 판정.
                // 리더선이 말풍선 정중앙에 닿도록 박스를 드롭 지점 중앙에. 확대해도 크기 유지(scale 1/zoom).
                const lblStyle: React.CSSProperties = {
                  left: p.lx,
                  top: p.ly,
                  transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                  transformOrigin: '50% 50%',
                };
                return (
                  <div
                    key={'lbl' + i}
                    className={'aq-lbl' + (i === selectedPin ? ' sel' : '') + (isActive ? ' active' : '')}
                    style={lblStyle}
                  >
                    {/* 말풍선 — 입력 중=현재 필드 안내 / 완료=2줄(품목·규격 / 단가·수량·합계). 드래그=이동, 더블클릭=재입력. */}
                    <div
                      className={'aq-pintag' + (isActive || hasContent ? '' : ' empty')}
                      style={{ background: pinColor(i) }}
                      title="드래그=이동 · 더블클릭=처음부터 입력/수정"
                      onMouseDown={(e) => startBubbleDrag(e, i)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEdit(i);
                      }}
                    >
                      {isActive ? (
                        <span className="aq-pin-guide">
                          {FIELDS[p.fi] ?? ''}
                          {FIELDS[p.fi] === '수량' && (p.vals['품목'] || '').trim() !== '' && (
                            <button
                              type="button"
                              title="품목에 입력한 글자 수만큼 수량에 넣기"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                commitDraft(String(charCount(p.vals['품목'] || '', 'all')));
                              }}
                              style={{
                                marginLeft: 7,
                                fontSize: '0.82em',
                                fontWeight: 700,
                                background: '#0a9396',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 5,
                                padding: '1px 7px',
                                cursor: 'pointer',
                                verticalAlign: 'middle',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              글씨갯수만큼 적용
                            </button>
                          )}
                        </span>
                      ) : hasContent ? (
                        <>
                          {top && <div className="aq-pin-l1">{top}</div>}
                          {priceLine && <div className="aq-pin-l2">{priceLine}</div>}
                        </>
                      ) : (
                        '✎ 더블클릭하여 입력'
                      )}
                    </div>
                    {isActive && (
                      <>
                        <div className="aq-inwrap">
                          <div className="aq-pinrow">
                            <input
                              ref={inputRef}
                              value={draft}
                              placeholder={`${FIELDS[p.fi] ?? ''} 입력 후 Enter`}
                              autoComplete="off"
                              inputMode={FIELDS[p.fi] === '단가' || FIELDS[p.fi] === '수량' ? 'numeric' : undefined}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (FIELDS[p.fi] === '단가') {
                                  setDraft(formatWon(v));
                                  return;
                                }
                                setDraft(v);
                                if (FIELDS[p.fi] === '품목코드') {
                                  const ms = matchCodes(v);
                                  const dym = didYouMean(v, ms);
                                  setAcIdx(dym ? ms.indexOf(dym) : -1); // 표준형 변형이면 미리 하이라이트
                                }
                              }}
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
                          {/* 품목코드 자동완성 드롭다운 — 입력칸은 고정, 드롭다운만 절대배치로 아래(또는 위)로. */}
                          {FIELDS[p.fi] === '품목코드' &&
                            draft.trim() &&
                            (() => {
                              const ms = matchCodes(draft);
                              if (ms.length === 0) return null;
                              const dym = didYouMean(draft, ms);
                              return (
                                <div
                                  className={'aq-acdrop' + (acAbove ? ' above' : '')}
                                  ref={acDropRef}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  {dym && acIdx === ms.indexOf(dym) && (
                                    <div className="aq-achint">
                                      혹시 <b>{dym}</b>? · Enter 적용 · → 그대로
                                    </div>
                                  )}
                                  <div className="aq-aclist">
                                    {ms.map((c, j) => (
                                      <div
                                        key={c}
                                        className={'aq-acitem' + (j === acIdx ? ' on' : '')}
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          commitDraft(c);
                                          setAcIdx(-1);
                                        }}
                                      >
                                        {c}
                                      </div>
                                    ))}
                                  </div>
                                  {ms.length > 5 && <div className="aq-acmore">+{ms.length - 5}개 더 · ↓로 탐색</div>}
                                </div>
                              );
                            })()}
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
                  const gstyle: React.CSSProperties = {
                    left: ghost.x,
                    top: ghost.y,
                    transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                    transformOrigin: '50% 50%',
                  };
                  return (
                    <div className="aq-lbl ghost" style={gstyle}
                    >
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
                </>
              )}
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
            <table
              className="aq-tbl"
              onFocus={() => setGridEditing(true)}
              onBlur={(e) => {
                // 표 안 셀끼리 이동(relatedTarget 이 표 내부)이면 유지, 표 밖으로 나가면 끔.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setGridEditing(false);
              }}
            >
              {/* 화면엔 품목코드·품목·규격·수량·단가·공급가액(+번호). 월일·세액·비고는 숨김 —
                  저장(buildGrid)·이지폼 매크로에서는 9칸 모두 채운다. */}
              <colgroup>
                <col style={{ width: 24 }} />
                <col style={{ width: 58 }} />
                <col />
                <col style={{ width: 56 }} />
                <col style={{ width: 34 }} />
                <col style={{ width: 78 }} />
                <col style={{ width: 86 }} />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th>품목코드</th>
                  <th>품목</th>
                  <th>규격</th>
                  <th>수량</th>
                  <th className="p">단가</th>
                  <th className="p">공급가액</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, i) => {
                  const p = pins[i];
                  const v = p ? p.vals : {};
                  const isOcrTgt = showTgtRow && i === ocrTarget;
                  return (
                    <tr
                      key={i}
                      className={`${i === active ? 'cur' : ''}${isOcrTgt ? ' ocrtgt' : ''}`.trim() || undefined}
                      style={isOcrTgt ? { background: hexToRgba(pinColor(i), 0.28) } : undefined}
                    >
                      <td className="rn">
                        {(p || isOcrTgt) && (
                          <span
                            className="rnum"
                            style={{ background: pinColor(i), cursor: p ? 'grab' : undefined }}
                            draggable={!!p}
                            onDragStart={(e) => {
                              e.dataTransfer.setData('application/x-aq-pin', String(i));
                              e.dataTransfer.effectAllowed = 'move';
                            }}
                            title={p ? '사진(지시서) 위로 드래그하면 이 칸 말풍선이 그 자리에 생겨요' : undefined}
                          >
                            {i + 1}
                          </span>
                        )}
                      </td>
                      <td>
                        <input
                          value={v['품목코드'] || ''}
                          onChange={(e) => {
                            setCell(i, '품목코드', e.target.value);
                            openGridAc(i, e.currentTarget);
                          }}
                          onFocus={(e) => openGridAc(i, e.currentTarget)}
                          onBlur={() => setTimeout(() => setGridAc((g) => (g && g.row === i ? null : g)), 150)}
                          onKeyDown={(e) => onGridCodeKey(e, i)}
                          data-gr={i}
                          data-gc={0}
                        />
                      </td>
                      <td className="it">
                        <input value={v['품목'] || ''} onChange={(e) => setCell(i, '품목', e.target.value)} data-gr={i} data-gc={1} onKeyDown={(e) => onGridKey(e, i, 1)} />
                      </td>
                      <td>
                        <input value={v['규격'] || ''} onChange={(e) => setCell(i, '규격', e.target.value)} data-gr={i} data-gc={2} onKeyDown={(e) => onGridKey(e, i, 2)} />
                      </td>
                      <td>
                        <input value={v['수량'] || ''} onChange={(e) => setCell(i, '수량', e.target.value)} data-gr={i} data-gc={3} onKeyDown={(e) => onGridKey(e, i, 3)} />
                      </td>
                      <td className="p">
                        <input
                          value={v['단가'] || ''}
                          onChange={(e) => setCell(i, '단가', e.target.value)}
                          onFocus={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setGridTool({ row: i, left: r.left, top: r.bottom });
                          }}
                          onBlur={() => setTimeout(() => setGridTool((g) => (g && g.row === i ? null : g)), 200)}
                          data-gr={i}
                          data-gc={4}
                          onKeyDown={(e) => onGridKey(e, i, 4)}
                        />
                      </td>
                      <td className="p">
                        {/* 공급가액 = 단가×수량 (총액). 읽기전용 — 단가·수량은 말풍선/위 칸에서 수정. */}
                        <input
                          className="ro"
                          value={(() => {
                            const u = num(v['단가']);
                            if (u == null) return '';
                            return (u * (num(v['수량']) || 1)).toLocaleString();
                          })()}
                          readOnly
                          tabIndex={-1}
                          title="공급가액 = 단가 × 수량"
                        />
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
              {saving ? '임시저장 중…' : '임시저장'}
            </button>
            <button className="aq-btn sh" onClick={captureShare}>
              공유하기
            </button>
            <button className="aq-btn ef" onClick={sendToEasyform} disabled={efBusy || !order}>
              {efBusy ? '보내는 중…' : '이지폼 입력'}
            </button>
          </div>
        </div>
      </div>

      {/* 우측 표 품목코드 자동완성 드롭다운 — 표 overflow 클리핑 회피로 포털+fixed. 말풍선과 동일 UI. */}
      {gridAc &&
        pins[gridAc.row] &&
        (() => {
          const cur = pins[gridAc.row].vals['품목코드'] || '';
          const ms = matchCodes(cur);
          if (!ms.length) return null;
          const dym = didYouMean(cur, ms);
          return createPortal(
            <div
              className="aq-acdrop"
              style={{
                position: 'fixed',
                left: gridAc.left,
                top: gridAc.top + 2,
                width: gridAc.width,
                zIndex: 3000,
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {dym && gridAc.idx === ms.indexOf(dym) && (
                <div className="aq-achint">
                  혹시 <b>{dym}</b> 인가요? · Enter 적용
                </div>
              )}
              <div className="aq-aclist">
                {ms.map((c, k) => (
                  <div
                    key={c}
                    className={'aq-acitem' + (k === gridAc.idx ? ' on' : '')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyGridCode(gridAc.row, c);
                    }}
                  >
                    {c}
                  </div>
                ))}
              </div>
              {ms.length > 5 && <div className="aq-acmore">+{ms.length - 5}개 더 · ↓로 탐색</div>}
            </div>,
            document.body,
          );
        })()}

      {/* 우측 표 단가칸 툴바 — 계산기 / 단가 찾아보기 (말풍선과 동일). 표 overflow 회피로 포털+fixed. */}
      {gridTool &&
        pins[gridTool.row] &&
        createPortal(
          <div
            style={{ position: 'fixed', left: gridTool.left, top: gridTool.top + 3, zIndex: 3000, display: 'flex', gap: 6 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              className="aq-lookup calc"
              onMouseDown={(e) => {
                e.preventDefault();
                const row = gridTool.row;
                setGridTool(null);
                runCalc(row);
              }}
            >
              🧮 계산기
            </button>
            <button
              className="aq-lookup"
              onMouseDown={(e) => {
                e.preventDefault();
                const row = gridTool.row;
                setGridTool(null);
                openLookup(row);
              }}
            >
              🔎 단가 찾아보기
            </button>
          </div>,
          document.body,
        )}

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
