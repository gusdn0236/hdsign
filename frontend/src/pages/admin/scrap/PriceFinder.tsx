import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE_URL, lookupPrices, type Prediction } from '../autoquote/annot/api';
import { parseInput, suggestTokens, TOKEN_LABEL } from '../StatementSmartSearch.jsx';
import FitWorksheet from './FitWorksheet';
import ScrapViewer, { loadViewerData, ZoomBox, type ViewerData } from './ScrapViewer';
import { ScrapPin } from './ScrapDrawer';
import { homeScrap, pastKey, scrap, tinyThumb, type ScrapItem, type ScrapRow } from './scrapStore';
import './Scrap.css';

/**
 * 단가찾아보기 — 이지폼 불러오기와 같은 키워드 화면.
 *  ① 지시서를 보면서 품목코드·품목·규격 같은 키워드를 하나씩 넣고 [찾기]
 *  ② 홈페이지에 저장된 명세서(빠름)가 먼저 뜨고, 이어서 예전 이지폼 명세서(단가찾아보기 코퍼스)가 붙는다
 *  ③ 마음에 드는 건 📌 로 스크랩 → 왼쪽 서랍에 담겨 다른 화면에서도 계속 보임
 * 명세서작성(지시서 있음)·단가계산기 탭(지시서 없음, embedded) 공용.
 */
export interface FinderOrder {
  id?: number;
  clientCompanyName?: string | null;
  title?: string | null;
  orderNumber?: string | null;
  worksheetPdfUrl?: string | null;
  worksheetThumbnailUrl?: string | null;
}

type Tok = { type: 'client' | 'code' | 'spec' | 'text' | 'order'; value: string };
// 단가찾아보기에서 쓰는 카테고리(주문번호는 안 씀) — 검색창 위 색깔 라벨·칩 종류 바꾸기 순서
const KINDS: Tok['type'][] = ['code', 'client', 'text', 'spec'];
const tokKey = (t: Tok) => `${t.type}:${String(t.value).replace(/\s+/g, '').toLowerCase()}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HomeHit = { o: any; hits: ScrapRow[]; hit: string[]; score: number; g: number };
type PastHit = { pr: Prediction; hit: string[]; score: number; g: number };

// 결과 묶음(사용자 2026-11-24) — 키워드를 사람마다 다르게 넣어도 '한 줄에서' 품목·규격이 같이 맞는 걸 먼저:
// 1 그 거래처 + 같은 품목·비슷한 규격 → 2 다른 거래처 + 같은 품목·비슷한 규격 → 3 같은 품목(규격 다름) → 4 규격만 비슷한 다른 품목
const GROUP_LABEL = (g: number, who: string, hasSpec: boolean) =>
  g === 1
    ? `${who || '이 거래처'} · ${hasSpec ? '품목·규격 딱 맞음' : '같은 품목'}`
    : g === 2
      ? `다른 거래처 · ${hasSpec ? '품목·규격 딱 맞음' : '같은 품목'}`
      : g === 3
        ? '같은 품목 · 규격은 다름'
        : '규격만 비슷한 다른 품목';
const squeezeS = (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase();
/** 한 줄 평가 — 품목코드·품목에 들어간 품목 키워드 수, 규격 가까움(0~1, 규격 키워드가 여럿이면 가장 안 맞는 것). */
function lineFit(text: string, size: string | undefined, itemToks: string[], specToks: string[]) {
  const t = squeezeS(text);
  const item = itemToks.filter((k) => t.includes(squeezeS(k))).length;
  const spec = specToks.length ? Math.min(...specToks.map((sv) => specNear(sv, size))) : 0;
  return { item, spec };
}
/** 묶음 번호(1~4). 0 = 어느 키워드와도 안 맞음. */
function groupOf(fit: { item: number; spec: number }, mine: boolean, hasItem: boolean, hasSpec: boolean): number {
  if (hasItem) {
    if (fit.item > 0 && (!hasSpec || fit.spec > 0)) return mine ? 1 : 2;
    if (fit.item > 0) return 3;
    return hasSpec && fit.spec > 0 ? 4 : 0;
  }
  return hasSpec && fit.spec > 0 ? (mine ? 1 : 2) : 0;
}

// 정렬 가중치 — 맞은 키워드 종류별 점수 합이 큰 순(거래처 > 품목코드 > 품목(작업키워드) > 규격)
const W = { client: 8, code: 4, text: 2, spec: 1 } as const;
const nums = (x?: string) => (String(x || '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0);
/** 규격 키워드가 이 규격에 얼마나 맞나 — 1 = 숫자 전부 ±3%(최소 5mm), 0.5 = ±10%, 0 = 아님. */
function specNear(want: string, have?: string): number {
  const w = nums(want);
  const h = nums(have);
  if (!w.length || !h.length) return 0;
  const ok = (tol: number) => w.every((n) => h.some((d) => Math.abs(d - n) <= Math.max(tol === 0.03 ? 5 : 0, n * tol)));
  return ok(0.03) ? 1 : ok(0.1) ? 0.5 : 0;
}

let clientNamesP: Promise<string[]> | null = null;
function loadClientNames(token: string | null | undefined): Promise<string[]> {
  if (!clientNamesP) {
    clientNamesP = fetch(`${BASE_URL}/api/admin/clients`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => Array.from(new Set((Array.isArray(list) ? list : []).map((c) => c.companyName).filter(Boolean))) as string[])
      .catch(() => {
        clientNamesP = null;
        return [];
      });
  }
  return clientNamesP;
}

const squeeze = (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase();
const won = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return String(v ?? '').trim() && Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}원` : '';
};
const shortDate = (d?: string) => {
  const m = String(d || '').match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1].slice(-2)}.${m[2].padStart(2, '0')}.${m[3].padStart(2, '0')}` : String(d || '');
};
const dnum = (d?: string) => {
  const m = String(d || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : 0;
};

function pastItem(pr: Prediction, client?: string): Omit<ScrapItem, 'addedAt'> {
  return {
    key: pastKey(pr.ref_file, pr.ref_invoice_idx),
    kind: 'past',
    invoiceIdx: pr.ref_invoice_idx,
    file: pr.ref_file,
    client: client || '',
    date: pr.date || '',
    rows: [{ 품목: pr.item, 규격: pr.size, 수량: pr.qty, 단가: String(pr.price) }],
  };
}

/** 예전 이지폼 명세서 카드 — 화면에 보일 때 근거(사진+명세서)를 받아 사진·거래처를 채운다. */
function PastCard({
  pr,
  hit,
  token,
  onOpen,
  onData,
  data,
}: {
  pr: Prediction;
  hit: string[];
  token: string | null | undefined;
  onOpen: () => void;
  onData: (d: ViewerData) => void;
  data?: ViewerData | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const k = { key: pastKey(pr.ref_file, pr.ref_invoice_idx), kind: 'past' as const, invoiceIdx: pr.ref_invoice_idx, file: pr.ref_file };
      loadViewerData(token, k)
        .then((d) => onData(d))
        .catch(() => {});
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.ref_file, pr.ref_invoice_idx, !!data]);
  const client = data?.client || '';
  const it = pastItem(pr, client);
  const photo = data?.photos?.[0];
  return (
    <div ref={ref} className="pf-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="pf-card-img">
        {photo ? <img src={photo} alt="" draggable={false} /> : data ? <span>📄</span> : <span className="sv-spin" />}
      </div>
      <div className="pf-card-body" title={hit.length ? `맞은 키워드: ${hit.join(', ')}` : undefined}>
        <div className="pf-card-price">{won(pr.price) || '단가 없음'}</div>
        <div className="pf-card-line">{[pr.item, pr.size].filter(Boolean).join(' · ')}</div>
        <div className="pf-card-meta">
          {client || '이지폼 예전 명세서'} · {shortDate(pr.date)}
        </div>
      </div>
      <ScrapPin
        item={it}
        className="pf-card-pin"
        onAdd={() => {
          if (photo) tinyThumb(photo).then((t) => t && scrap.patch(it.key, { thumb: t, client }));
        }}
      />
    </div>
  );
}

function HomeCard({ h, onOpen }: { h: HomeHit; onOpen: () => void }) {
  const { o, hits } = h;
  const top = hits[0]; // 가장 잘 맞는 줄(정렬에서 맨 앞)
  return (
    <div className="pf-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="pf-card-img">
        {o.worksheetThumbnailUrl ? <img src={o.worksheetThumbnailUrl} alt="" loading="lazy" draggable={false} /> : <span>📄</span>}
      </div>
      <div className="pf-card-body" title={h.hit.length ? `맞은 키워드: ${h.hit.join(', ')}` : undefined}>
        <div className="pf-card-price">{won(top?.단가) || '단가 없음'}</div>
        <div className="pf-card-line">
          {[top?.품목 || top?.품목코드, top?.규격].filter(Boolean).join(' · ') || '—'}
          {hits.length > 1 && <em> 외 {hits.length - 1}줄</em>}
        </div>
        <div className="pf-card-meta">
          {o.clientCompanyName || '거래처 없음'} · {shortDate(o.dueDate || o.createdAt)}
        </div>
      </div>
      <ScrapPin item={homeScrap(o, hits)} className="pf-card-pin" />
    </div>
  );
}

export default function PriceFinder({
  token,
  order,
  initial,
  autoRun = false,
  embedded = false,
  onClose,
}: {
  token: string | null | undefined;
  order?: FinderOrder | null;
  initial?: string[];
  autoRun?: boolean;
  embedded?: boolean;
  onClose?: () => void;
}) {
  const [kw, setKw] = useState<Tok[]>(() =>
    (initial || [])
      .map((x) => x.trim())
      .filter(Boolean)
      .flatMap((x) => (parseInput(x, new Map()) as Tok[]).filter((t) => t.type !== 'order')),
  );
  const [text, setText] = useState('');
  const [sugOpen, setSugOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [delArmed, setDelArmed] = useState(false);
  const [phase, setPhase] = useState<'clue' | 'result'>('clue');
  const [clientNames, setClientNames] = useState<string[]>([]);
  const [home, setHome] = useState<HomeHit[] | null>(null);
  const [homeErr, setHomeErr] = useState(false);
  const [past, setPast] = useState<PastHit[] | null>(null);
  const [pastErr, setPastErr] = useState('');
  const [pastData, setPastData] = useState<Record<string, ViewerData>>({});
  const [detail, setDetail] = useState<number | null>(null); // 합친 목록(home → past) 안의 위치
  const [specOpen, setSpecOpen] = useState(false); // '규격만 비슷한 다른 품목' 펼침(처음엔 접힘)
  const [moreG, setMoreG] = useState<Record<number, boolean>>({}); // 묶음별 [더 보기]
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const hasWs = !!(order && (order.worksheetPdfUrl || order.worksheetThumbnailUrl));

  useEffect(() => {
    loadClientNames(token).then(setClientNames);
  }, [token]);
  useEffect(() => {
    if (phase === 'clue') setTimeout(() => input.current?.focus(), 30);
  }, [phase]);

  const clientIndex = useMemo(() => {
    const m = new Map<string, string>();
    clientNames.forEach((n) => m.set(squeeze(n), n));
    return m;
  }, [clientNames]);

  const run = async (list: Tok[]) => {
    const my = ++seq.current;
    setPhase('result');
    setDetail(null);
    setHome(null);
    setHomeErr(false);
    setPast(null);
    setPastErr('');
    setPastData({});
    setSpecOpen(false);
    setMoreG({});
    const toks: Tok[] = list;
    const pick = (t: Tok['type']) => toks.filter((x) => x.type === t).map((x) => x.value);
    const codes = pick('code');
    const specs = pick('spec');
    const texts = pick('text');
    const clients = pick('client');
    const myClient = order?.clientCompanyName || '';

    const cliHit = (name?: string | null) => clients.some((c) => squeeze(name || '').includes(squeeze(c)));

    // ① 홈페이지에 저장된 명세서 — 키워드마다 따로 찾아 합친 뒤, 맞은 키워드 점수(거래처>품목코드>품목>규격)가
    //    큰 순. 동점이면 이 지시서 거래처 먼저 → 최신순.
    const rowToks = toks.filter((t) => t.type === 'code' || t.type === 'text' || t.type === 'spec');
    if (!rowToks.length) {
      setHome([]);
    } else {
      Promise.all(
        rowToks.map((t) => {
          const qs = new URLSearchParams();
          qs.append(t.type, t.value);
          qs.set('requestType', 'ORDER');
          return fetch(`${BASE_URL}/api/admin/orders/statement-search?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => ({ t, d }))
            .catch(() => ({ t, d: null }));
        }),
      ).then((res) => {
        if (my !== seq.current) return;
        if (res.every((x) => !x.d)) {
          setHome([]);
          setHomeErr(true);
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agg = new Map<number, { o: any; rows: ScrapRow[]; toks: Tok[] }>();
        res.forEach(({ t, d }) => {
          if (!d) return;
          (Array.isArray(d.items) ? d.items : []).forEach((o) => {
            if (o.id === order?.id || (o.requestType && o.requestType !== 'ORDER')) return;
            let a = agg.get(o.id);
            if (!a) {
              a = { o, rows: [], toks: [] };
              agg.set(o.id, a);
            }
            if (!a.toks.includes(t)) a.toks.push(t);
            ((d.matches || {})[String(o.id)] || []).forEach((r: ScrapRow) => {
              const k = JSON.stringify([r.품목코드, r.품목, r.규격, r.단가]);
              if (!a!.rows.some((x) => JSON.stringify([x.품목코드, x.품목, x.규격, x.단가]) === k)) a!.rows.push(r);
            });
          });
        });
        const itemToks = [...codes, ...texts];
        const hasItem = itemToks.length > 0;
        const hasSpec = specs.length > 0;
        const isMine = (name?: string | null) =>
          clients.length ? cliHit(name) : !!myClient && squeeze(name || '') === squeeze(myClient);
        const out: HomeHit[] = [...agg.values()].map((a) => {
          // 줄마다 평가 → 가장 잘 맞는 줄로 묶음을 정하고, 카드에도 잘 맞는 줄부터 보여 줌
          const mineA = isMine(a.o.clientCompanyName);
          const fits = a.rows.map((r) => ({ r, f: lineFit(`${r.품목코드 || ''} ${r.품목 || ''}`, r.규격, itemToks, specs) }));
          const gOf = (f: { item: number; spec: number }) => groupOf(f, mineA, hasItem, hasSpec) || 9;
          fits.sort((x, y) => gOf(x.f) - gOf(y.f) || y.f.item - x.f.item || y.f.spec - x.f.spec);
          a.rows = fits.map((x) => x.r);
          const best = fits[0]?.f || { item: 0, spec: 0 };
          const g = groupOf(best, mineA, hasItem, hasSpec) || 4;
          // 묶음 안 순서: 품목코드로 맞은 줄 > 작업키워드로만 맞은 줄 > 규격 더 가까움 > (그 거래처) > 최신
          const bestRow = fits[0]?.r;
          const codeHit = bestRow
            ? lineFit(`${bestRow.품목코드 || ''} ${bestRow.품목 || ''}`, bestRow.규격, codes, []).item
            : 0;
          let score = codeHit * 20 + best.item * W.code + best.spec * W.spec * 2 + (mineA ? W.client : 0);
          score += a.toks.reduce((sum, t) => sum + W[t.type as keyof typeof W], 0) / 100; // 동점 정리용
          const hit = a.toks.map((t) => t.value);
          // 규격 키워드로는 안 걸렸어도 걸린 줄 규격이 가까우면 반점
          specs.forEach((sv) => {
            if (hit.includes(sv)) return;
            if (a.rows.some((r) => specNear(sv, r.규격) > 0)) score += W.spec / 2;
          });
          if (clients.length && cliHit(a.o.clientCompanyName)) {
            score += W.client;
            hit.unshift(a.o.clientCompanyName);
          }
          return { o: a.o, hits: a.rows, hit, score, g };
        });
        const mine = (h: HomeHit) => (myClient && h.o.clientCompanyName === myClient ? 0 : 1);
        out.sort(
          (a, b) =>
            a.g - b.g ||
            b.score - a.score ||
            mine(a) - mine(b) ||
            dnum(String(b.o.dueDate || b.o.createdAt)) - dnum(String(a.o.dueDate || a.o.createdAt)),
        );
        setHome(out.slice(0, 60));
      });
    }

    // ② 예전 이지폼 명세서 — 품목코드·품목 키워드마다 기존 단가찾아보기로 찾아 합친 뒤 같은 점수로 정렬.
    //    품목 글자가 그 키워드를 실제로 품고 있으면 만점, 연관으로만 걸렸으면 반점. 규격은 가까운 정도로.
    //    거래처 키워드가 있으면 그 거래처 명세서(이력)에 거래처 점수. 사진 있는 것만 50건.
    const textToks = toks.filter((t) => t.type === 'code' || t.type === 'text');
    if (!textToks.length) {
      setPast([]);
      return;
    }
    const rankClient = clients[0] || myClient;
    const lists = await Promise.all(
      textToks.map((t) =>
        lookupPrices(token, rankClient, { text: t.value, material: t.value, size: specs[0] || '', qty: '' }, 100)
          .then((l) => ({ t, l, err: false }))
          .catch(() => ({ t, l: null as Prediction[] | null, err: true })),
      ),
    );
    if (my !== seq.current) return;
    if (lists.every((x) => x.l == null)) {
      setPast([]);
      setPastErr(lists.some((x) => x.err) ? '예전 명세서를 찾지 못했어요' : '예전 명세서 자료가 서버에 아직 없어요');
      return;
    }
    const agg = new Map<string, { pr: Prediction; toks: Tok[] }>();
    lists.forEach(({ t, l }) =>
      (l || []).forEach((pr) => {
        if (pr.photo_available === false) return;
        const k = pastKey(pr.ref_file, pr.ref_invoice_idx);
        const a = agg.get(k);
        if (!a) agg.set(k, { pr, toks: [t] });
        else {
          if (!a.toks.includes(t)) a.toks.push(t);
          if ((pr.score ?? 0) > (a.pr.score ?? 0)) a.pr = pr;
        }
      }),
    );
    const pItem = [...codes, ...texts];
    const scored: PastHit[] = [...agg.values()].map(({ pr, toks: ts }) => {
      // 예전 이지폼 명세서 — '이력'(그 거래처 명세서)이면 그 거래처로 봄
      const fit = lineFit(pr.item, pr.size, pItem, specs);
      const g = groupOf(fit, pr.src === '이력', pItem.length > 0, specs.length > 0) || 4;
      let score = lineFit(pr.item, pr.size, codes, []).item * 20; // 품목코드로 맞은 것 먼저
      const hit: string[] = [];
      ts.forEach((t) => {
        const full = squeeze(pr.item).includes(squeeze(t.value));
        score += W[t.type as keyof typeof W] * (full ? 1 : 0.5);
        if (full) hit.push(t.value);
      });
      specs.forEach((sv) => {
        const n = specNear(sv, pr.size);
        score += W.spec * n;
        if (n === 1) hit.push(sv);
      });
      if (clients.length && pr.src === '이력') {
        score += W.client;
        hit.unshift(clients[0]);
      }
      return { pr, hit, score, g };
    });
    scored.sort((a, b) => a.g - b.g || b.score - a.score || (b.pr.score ?? 0) - (a.pr.score ?? 0) || dnum(b.pr.date) - dnum(a.pr.date));
    setPast(scored.slice(0, 50));
  };

  useEffect(() => {
    if (autoRun && kw.length) run(kw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 키워드 더하기 — 같은 종류·같은 글자면 안 넣음
  const merge = (base: Tok[], add: Tok[]) => {
    const next = [...base];
    add.forEach((t) => {
      if (t.type !== 'order' && !next.some((x) => tokKey(x) === tokKey(t))) next.push(t);
    });
    return next;
  };
  const addTokens = (add: Tok[]) => {
    setKw((prev) => merge(prev, add));
    setText('');
    setHi(-1);
  };
  // 치는 동안 아래에 종류 추천(똑똑한 검색창과 같음) — 마지막 단어 기준
  const lastWord = text.split(/\s+/).pop() || '';
  const suggestions = useMemo(
    () =>
      (suggestTokens(lastWord, clientNames) as Tok[]).filter(
        (t) => t.type !== 'order' && !kw.some((x) => tokKey(x) === tokKey(t)),
      ),
    [lastWord, clientNames, kw],
  );
  const showSuggest = sugOpen && suggestions.length > 0;
  const pickSuggestion = (t: Tok) => {
    const head = text.trim().split(/\s+/).slice(0, -1).join(' ');
    addTokens([...(parseInput(head, clientIndex) as Tok[]), t]);
    input.current?.focus();
  };
  const cycleType = (i: number) =>
    setKw((prev) => prev.map((x, j) => (j === i ? { ...x, type: KINDS[(KINDS.indexOf(x.type) + 1) % KINDS.length] } : x)));
  const startNow = () => {
    const next = text.trim() ? merge(kw, parseInput(text, clientIndex) as Tok[]) : kw;
    setKw(next);
    setText('');
    setSugOpen(false);
    if (!next.length) {
      input.current?.focus();
      return;
    }
    run(next);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Backspace') setDelArmed(false);
    if (e.key === 'ArrowDown' && showSuggest) {
      e.preventDefault();
      setHi((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === 'ArrowUp' && showSuggest) {
      e.preventDefault();
      setHi((h) => Math.max(-1, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showSuggest && hi >= 0 && suggestions[hi]) pickSuggestion(suggestions[hi]);
      else if (text.trim()) addTokens(parseInput(text, clientIndex) as Tok[]);
      else startNow();
    } else if (e.key === 'Escape' && showSuggest) {
      e.preventDefault();
      e.stopPropagation();
      setSugOpen(false);
    } else if (e.key === 'Backspace' && !text && kw.length) {
      e.preventDefault();
      if (!delArmed) setDelArmed(true);
      else {
        setKw(kw.slice(0, -1));
        setDelArmed(false);
      }
    }
  };

  // 크게 보기용 합친 목록 — **화면에 보이는 순서 그대로**(묶음 ① → ④, 같은 묶음 안에선 홈페이지 먼저 → 순위)라
  // ‹ › 로 넘기면 우선순위 높은 것부터 낮은 것으로(사용자 2026-11-24: 예전엔 홈페이지 전체 → 이지폼 전체 순이라 뒤섞임).
  const navSeq = useMemo(() => {
    const list: { src: 'h' | 'p'; i: number; g: number }[] = [
      ...(home || []).map((h, i) => ({ src: 'h' as const, i, g: h.g })),
      ...(past || []).map((x, i) => ({ src: 'p' as const, i, g: x.g })),
    ];
    return list.sort((a, b) => a.g - b.g || (a.src === b.src ? 0 : a.src === 'h' ? -1 : 1) || a.i - b.i);
  }, [home, past]);
  const posOf = useMemo(() => {
    const m = new Map<string, number>();
    navSeq.forEach((x, n) => m.set(`${x.src}${x.i}`, n));
    return m;
  }, [navSeq]);
  const all = useMemo(
    () =>
      navSeq.map(({ src, i }) => {
        if (src === 'h') {
          const h = home![i];
          return { item: homeScrap(h.o, h.hits) } as { item: Omit<ScrapItem, 'addedAt'>; data?: ViewerData | null };
        }
        const { pr } = past![i];
        const d = pastData[pastKey(pr.ref_file, pr.ref_invoice_idx)];
        return { item: pastItem(pr, d?.client), data: d || null };
      }),
    [navSeq, home, past, pastData],
  );
  const cur = detail != null ? all[detail] : null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // 추천 목록 닫기 Esc 등 — 입력칸이 이미 처리함
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        if (e.key !== 'Escape') return;
      }
      if (detail != null) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setDetail(null);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setDetail((d) => (d != null && d > 0 ? d - 1 : d));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setDetail((d) => (d != null && d < all.length - 1 ? d + 1 : d));
        }
        return;
      }
      if (e.key === 'Escape' && !embedded) {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detail, all.length, embedded, onClose]);

  const top = (
    <div className="efb-top pf-top">
      <span className="efb-title">
        <span className="efb-title-icon">🔎</span>단가찾아보기
      </span>
      {phase === 'result' && (
        <button type="button" className="pf-kwbar" onClick={() => setPhase('clue')} title="키워드 고치기">
          {kw.map((t) => (
            <span key={tokKey(t)} className={`pf-chip pf-chip--${t.type}`}>
              <span className="pf-chip-type">{TOKEN_LABEL[t.type]}</span>
              {t.value}
            </span>
          ))}
          <span className="pf-kwedit">✎ 키워드 고치기</span>
        </button>
      )}
      {onClose && (
        <button type="button" className="efb-x pf-close-all" onClick={onClose} aria-label="단가찾아보기 닫기" title="단가찾아보기 닫기">
          ✕
        </button>
      )}
    </div>
  );

  const clueSide = (
    <aside className="efb-clue-side">
      {order && (
        <div className="efb-clue-order">
          <b>{order.clientCompanyName || '거래처 없음'}</b>
          {order.orderNumber ? <span>{order.orderNumber}</span> : null}
        </div>
      )}
      {/* 검색 카테고리 — 칩과 같은 색 라벨 */}
      <div className="pf-legend" aria-label="검색 카테고리">
        {KINDS.map((k) => (
          <span key={k} className={`pf-chip pf-chip--${k} pf-legend-tag`}>
            {TOKEN_LABEL[k]}
          </span>
        ))}
      </div>
      <div className="pf-inputwrap">
        <input
          ref={input}
          className="efb-clue-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDelArmed(false);
            setHi(-1);
            setSugOpen(true);
          }}
          onFocus={() => setSugOpen(true)}
          onBlur={() => {
            setDelArmed(false);
            setTimeout(() => setSugOpen(false), 150);
          }}
          onKeyDown={onKey}
          placeholder="키워드를 입력하세요."
          aria-label="키워드"
          autoComplete="off"
        />
        {showSuggest && (
          <ul className="pf-pop" onMouseDown={(e) => e.preventDefault()}>
            {suggestions.map((t, k) => (
              <li
                key={tokKey(t)}
                className={k === hi ? 'is-hi' : ''}
                onMouseEnter={() => setHi(k)}
                onClick={() => pickSuggestion(t)}
              >
                <span className={`pf-chip pf-chip--${t.type} pf-pop-type`}>{TOKEN_LABEL[t.type]}</span>
                {t.value}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="efb-clue-chips">
        {kw.map((t, i) => (
          <span
            key={tokKey(t)}
            className={`pf-chip pf-chip--${t.type} ${delArmed && i === kw.length - 1 ? 'is-armed' : ''}`}
          >
            <button
              type="button"
              className="pf-chip-body"
              onClick={() => cycleType(i)}
              title={`${TOKEN_LABEL[t.type]} — 누르면 종류 바꾸기`}
            >
              <span className="pf-chip-type">{TOKEN_LABEL[t.type]}</span>
              {t.value}
            </button>
            <button
              type="button"
              className="pf-chip-x"
              onClick={() => setKw(kw.filter((_, j) => j !== i))}
              aria-label={`${t.value} 지우기`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="pf-spacer" />
      <div className="efb-clue-btns">
        <button type="button" className="efb-primary" onClick={startNow} disabled={!kw.length && !text.trim()}>
          찾기
        </button>
      </div>
    </aside>
  );

  const pending = (
    <div className="pf-pending">
      <span className="sv-spin" /> 찾는 중…
    </div>
  );

  // 묶음 제목용 — 거래처 키워드가 있으면 그 이름, 없으면 이 지시서 거래처
  const who = kw.find((t) => t.type === 'client')?.value || order?.clientCompanyName || '';
  const hasSpecKw = kw.some((t) => t.type === 'spec');
  // 결과 화면(사용자 2026-11-24: 규격만 맞는 지시서가 주르륵 나와 보기 힘듦) —
  // 위: '찾은 결과'(품목·키워드와 규격이 한 줄에서 같이 맞음 → 그 거래처 / 다른 거래처 / 규격 다름) 묶음마다 8건 + [더 보기]
  // 아래: '규격만 비슷한 다른 품목'은 접어 두고 건수만. 홈페이지·이지폼 예전 명세서는 같은 묶음 안에 같이(홈페이지 먼저).
  const LIMIT = 6;
  type Cell = { key: string; g: number; el: React.ReactElement };
  const cells: Cell[] = [
    ...(home || []).map((x, j) => ({
      key: `h${x.o.id}`,
      g: x.g,
      el: <HomeCard key={`h${x.o.id}`} h={x} onOpen={() => setDetail(posOf.get(`h${j}`) ?? null)} />,
    })),
    ...(past || []).map(({ pr, hit, g }, j) => {
      const k = pastKey(pr.ref_file, pr.ref_invoice_idx);
      return {
        key: `p${k}`,
        g,
        el: (
          <PastCard
            key={`p${k}`}
            pr={pr}
            hit={hit}
            token={token}
            data={pastData[k]}
            onData={(d) => setPastData((m) => ({ ...m, [k]: d }))}
            onOpen={() => setDetail(posOf.get(`p${j}`) ?? null)}
          />
        ),
      };
    }),
  ];
  const loading = home == null || past == null;
  const mainCells = cells.filter((c) => c.g <= 3);
  const specCells = cells.filter((c) => c.g >= 4);
  const groupBox = (g: number, list: Cell[]) => {
    const open = !!moreG[g];
    const shown = open ? list : list.slice(0, LIMIT);
    return (
      <div key={`g${g}`} className={'pf-group' + (g === 1 ? ' best' : '')}>
        <div className="pf-group-h">
          {GROUP_LABEL(g, who, hasSpecKw)}
          <b>{list.length}</b>
        </div>
        <div className="pf-grid">{shown.map((c) => c.el)}</div>
        {list.length > LIMIT && (
          <button type="button" className="pf-more" onClick={() => setMoreG((m) => ({ ...m, [g]: !open }))}>
            {open ? '접기' : `${list.length - LIMIT}건 더 보기`}
          </button>
        )}
      </div>
    );
  };
  const results = (
    <div className="pf-results">
      <section className="pf-main">
        <h4>
          찾은 결과 {!loading ? <b>{mainCells.length}</b> : null}
          {(homeErr || pastErr) && <span className="pf-warn">{homeErr ? '홈페이지 명세서를 못 찾았어요' : pastErr}</span>}
        </h4>
        {[1, 2, 3].map((g) => {
          const list = mainCells.filter((c) => c.g === g);
          return list.length ? groupBox(g, list) : null;
        })}
        {loading ? pending : !mainCells.length && <div className="pf-none">키워드와 규격이 같이 맞는 명세서가 없어요</div>}
      </section>
      {specCells.length > 0 && (
        <section className="pf-sub">
          <button type="button" className="pf-sub-toggle" onClick={() => setSpecOpen((v) => !v)}>
            <span>{specOpen ? '▾' : '▸'}</span> 규격만 비슷한 다른 품목 <b>{specCells.length}</b>
            <small>{specOpen ? '접기' : '펼쳐 보기'}</small>
          </button>
          {specOpen && <div className="pf-grid">{specCells.map((c) => c.el)}</div>}
        </section>
      )}
    </div>
  );

  const detailView = cur && (
    <div className="pf-detail">
      <div className="pf-detail-head">
        <button type="button" className="efb-x" onClick={() => setDetail(null)}>
          ‹ 목록
        </button>
        <b>{cur.item.client || '거래처'}</b>
        <span>{shortDate(cur.item.date)}</span>
        <span className="pf-detail-nav">
          <button type="button" className="efb-x" disabled={detail === 0} onClick={() => setDetail((d) => (d! > 0 ? d! - 1 : d))}>
            ‹
          </button>
          <span>
            {detail! + 1} / {all.length}
          </span>
          <button
            type="button"
            className="efb-x"
            disabled={detail === all.length - 1}
            onClick={() => setDetail((d) => (d! < all.length - 1 ? d! + 1 : d))}
          >
            ›
          </button>
        </span>
        <ScrapPin
          item={cur.item}
          label
          className="pf-detail-pin"
          onAdd={() => {
            const ph = cur.data?.photos?.[0];
            if (cur.item.kind === 'past' && ph) tinyThumb(ph).then((t) => t && scrap.patch(cur.item.key, { thumb: t }));
          }}
        />
        <button
          type="button"
          className="pf-detail-close"
          onClick={() => setDetail(null)}
          aria-label="이 명세서 닫기"
          title="이 명세서만 닫고 목록으로"
        >
          ✕
        </button>
      </div>
      <ScrapViewer token={token} item={cur.item} data={cur.data || undefined} />
    </div>
  );

  return (
    <div className={`efb pf ${embedded ? 'pf-embedded' : ''}`} role={embedded ? undefined : 'dialog'} aria-label="단가찾아보기">
      {top}
      {phase === 'clue' ? (
        <div className={`efb-clue ${hasWs ? '' : 'pf-clue-nows'}`}>
          {hasWs && (
            <div className="efb-clue-ws">
              <ZoomBox resetKey={String(order!.id ?? '')}>
                <FitWorksheet pdfUrl={order!.worksheetPdfUrl} thumbUrl={order!.worksheetThumbnailUrl} title={order!.title} />
              </ZoomBox>
            </div>
          )}
          {clueSide}
        </div>
      ) : (
        <div className={`pf-body ${hasWs ? '' : 'pf-body-nows'}`}>
          {hasWs && (
            <div className="pf-myws">
              <ZoomBox resetKey={String(order!.id ?? '')}>
                <FitWorksheet pdfUrl={order!.worksheetPdfUrl} thumbUrl={order!.worksheetThumbnailUrl} title={order!.title} />
              </ZoomBox>
            </div>
          )}
          <div className="pf-main">
            {results}
            {detailView}
          </div>
        </div>
      )}
    </div>
  );
}
