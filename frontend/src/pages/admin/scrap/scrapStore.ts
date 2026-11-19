import { useSyncExternalStore } from 'react';

/**
 * 스크랩(장바구니) — 단가찾아보기·명세서 탭 검색에서 고른 지시서&명세서를 담아 두고
 * 관리자 화면 왼쪽 서랍에 계속 띄워 둔다. 이 PC 에만 저장(localStorage). 다른 PC 와 공유 안 함.
 *
 *  - home: 홈페이지에 저장된 명세서(주문 id 로 지시서·명세서를 다시 불러옴)
 *  - past: 예전 이지폼 명세서(단가찾아보기 코퍼스 — invoiceIdx+file 로 근거를 다시 불러옴)
 */
export interface ScrapRow {
  품목코드?: string;
  품목?: string;
  규격?: string;
  수량?: string;
  단가?: string;
}

export interface ScrapItem {
  key: string; // 'h:<orderId>' | 'p:<file>|<idx>'
  kind: 'home' | 'past';
  orderId?: number;
  orderNumber?: string;
  invoiceIdx?: string | number;
  file?: string;
  client: string;
  date: string; // 'YYYY-MM-DD' 또는 'YYYY.MM.DD'
  thumb?: string; // 미리보기 사진 URL(home) 또는 작은 data URL(past)
  pdfUrl?: string;
  rows: ScrapRow[]; // 검색에 걸린 줄(카드에 보여줄 것, 최대 3)
  addedAt: number;
}

const KEY = 'hd.scrap.v1';
const COLLAPSE_KEY = 'hd.scrap.collapsed';
const PANEL_W_KEY = 'hd.scrap.panelW';

function load(): ScrapItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface State {
  items: ScrapItem[];
  openKey: string | null; // 참고 창에 띄운 스크랩
  collapsed: boolean;
}

let state: State = {
  items: load(),
  openKey: null,
  collapsed: (() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  })(),
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function set(next: Partial<State>, persist = false) {
  state = { ...state, ...next };
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state.items));
    } catch {
      /* 저장 불가(용량·사생활 모드) — 이번 화면에서만 유지 */
    }
  }
  emit();
}

// 다른 탭에서 바꾼 것도 따라오게.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) set({ items: load() });
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useScrap(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export const scrap = {
  has: (key: string) => state.items.some((x) => x.key === key),
  add(item: Omit<ScrapItem, 'addedAt'>) {
    if (state.items.some((x) => x.key === item.key)) return;
    set({ items: [{ ...item, addedAt: Date.now() }, ...state.items] }, true);
  },
  remove(key: string) {
    set({ items: state.items.filter((x) => x.key !== key), openKey: state.openKey === key ? null : state.openKey }, true);
  },
  toggle(item: Omit<ScrapItem, 'addedAt'>) {
    if (scrap.has(item.key)) scrap.remove(item.key);
    else scrap.add(item);
  },
  /** 나중에 채워진 정보(작은 사진 등)만 덧붙인다. */
  patch(key: string, p: Partial<ScrapItem>) {
    if (!state.items.some((x) => x.key === key)) return;
    set({ items: state.items.map((x) => (x.key === key ? { ...x, ...p } : x)) }, true);
  },
  clear() {
    set({ items: [], openKey: null }, true);
  },
  move(from: number, to: number) {
    const list = state.items.slice();
    if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
    const [it] = list.splice(from, 1);
    list.splice(to, 0, it);
    set({ items: list }, true);
  },
  open(key: string | null) {
    set({ openKey: state.openKey === key ? null : key });
  },
  setCollapsed(v: boolean) {
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* 무시 */
    }
    set({ collapsed: v });
  },
};

export function loadPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(PANEL_W_KEY));
    if (Number.isFinite(n) && n >= 320) return n;
  } catch {
    /* 무시 */
  }
  return Math.min(760, Math.round(window.innerWidth * 0.45));
}
export function savePanelWidth(w: number) {
  try {
    localStorage.setItem(PANEL_W_KEY, String(Math.round(w)));
  } catch {
    /* 무시 */
  }
}

/** 홈페이지 명세서(주문 카드) → 스크랩 항목. o = 주문 응답, hits = 검색에 걸린 줄. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function homeScrap(o: any, hits?: ScrapRow[]): Omit<ScrapItem, 'addedAt'> {
  return {
    key: `h:${o.id}`,
    kind: 'home',
    orderId: Number(o.id),
    orderNumber: o.orderNumber || '',
    client: o.clientCompanyName || '',
    date: String(o.dueDate || o.createdAt || '').slice(0, 10),
    thumb: o.worksheetThumbnailUrl || undefined,
    pdfUrl: o.worksheetPdfUrl || undefined,
    rows: (hits || []).slice(0, 3).map((h) => ({
      품목코드: h['품목코드'] || '',
      품목: h['품목'] || '',
      규격: h['규격'] || '',
      수량: h['수량'] || '',
      단가: h['단가'] || '',
    })),
  };
}

export const pastKey = (file: string, idx: string | number) => `p:${file}|${idx}`;

/** 사진 data URL → 서랍 카드용 작은 JPEG(가로 160px). localStorage 에 넣을 수 있게 작게. */
export function tinyThumb(dataUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const w = 160;
      const h = Math.max(1, Math.round((im.naturalHeight / Math.max(1, im.naturalWidth)) * w));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      if (!g) return resolve(undefined);
      g.drawImage(im, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.6));
    };
    im.onerror = () => resolve(undefined);
    im.src = dataUrl;
  });
}
