import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE_URL, lookupPricesMerged, type Prediction } from '../autoquote/annot/api';
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
type HomeHit = { o: any; hits: ScrapRow[] };

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
  token,
  onOpen,
  onData,
  data,
}: {
  pr: Prediction;
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
      <div className="pf-card-body">
        <div className="pf-card-top">
          <b>{client || pr.src || ' '}</b>
          <span>{shortDate(pr.date)}</span>
        </div>
        <div className="pf-card-row">
          <span>
            {pr.item} {pr.size}
          </span>
          <i>{won(pr.price)}</i>
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
  return (
    <div className="pf-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="pf-card-img">
        {o.worksheetThumbnailUrl ? <img src={o.worksheetThumbnailUrl} alt="" loading="lazy" draggable={false} /> : <span>📄</span>}
      </div>
      <div className="pf-card-body">
        <div className="pf-card-top">
          <b>{o.clientCompanyName || '거래처 없음'}</b>
          <span>{shortDate(o.dueDate || o.createdAt)}</span>
        </div>
        {hits.slice(0, 3).map((r, k) => (
          <div key={k} className="pf-card-row">
            <span>
              {r.품목 || r.품목코드} {r.규격}
            </span>
            <i>{won(r.단가)}</i>
          </div>
        ))}
        {hits.length > 3 && <div className="pf-card-more">외 {hits.length - 3}줄</div>}
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
  const [past, setPast] = useState<Prediction[] | null>(null);
  const [pastErr, setPastErr] = useState('');
  const [pastData, setPastData] = useState<Record<string, ViewerData>>({});
  const [detail, setDetail] = useState<number | null>(null); // 합친 목록(home → past) 안의 위치
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
    const toks: Tok[] = list;
    const pick = (t: Tok['type']) => toks.filter((x) => x.type === t).map((x) => x.value);
    const codes = pick('code');
    const specs = pick('spec');
    const texts = pick('text');
    const clients = pick('client');
    const myClient = order?.clientCompanyName || '';

    // ① 홈페이지에 저장된 명세서 — 같은 줄에 키워드가 다 있는 명세서(최신순). 같은 거래처 먼저.
    if (codes.length + specs.length + texts.length === 0) {
      setHome([]);
    } else {
      const qs = new URLSearchParams();
      codes.forEach((v) => qs.append('code', v));
      specs.forEach((v) => qs.append('spec', v));
      texts.forEach((v) => qs.append('text', v));
      clients.forEach((v) => qs.append('client', v));
      qs.set('requestType', 'ORDER');
      fetch(`${BASE_URL}/api/admin/orders/statement-search?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((data) => {
          if (my !== seq.current) return;
          const items = (Array.isArray(data.items) ? data.items : []).filter((o) => o.id !== order?.id);
          const out: HomeHit[] = items.map((o) => ({ o, hits: (data.matches || {})[String(o.id)] || [] }));
          const mine = (h: HomeHit) => (myClient && h.o.clientCompanyName === myClient ? 0 : 1);
          out.sort((a, b) => mine(a) - mine(b)); // 같은 거래처 먼저, 그 안은 서버 순서(최신 저장순)
          setHome(out);
        })
        .catch(() => my === seq.current && (setHome([]), setHomeErr(true)));
    }

    // ② 예전 이지폼 명세서 — 기존 단가찾아보기(사이즈 비슷한 순 → 최신순), 사진 있는 것만 30건.
    const terms = [...codes, ...texts];
    if (!terms.length) {
      setPast([]);
      return;
    }
    try {
      const preds = await lookupPricesMerged(token, clients[0] || myClient, terms, specs[0] || '', '', {
        fallbackText: texts.join(' '),
        limit: 100,
      });
      if (my !== seq.current) return;
      if (preds == null) {
        setPast([]);
        setPastErr('예전 명세서 자료가 서버에 아직 없어요');
        return;
      }
      const hasFlag = preds.some((p) => p.photo_available !== undefined);
      const withPhoto = hasFlag ? preds.filter((p) => p.photo_available) : preds;
      withPhoto.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || dnum(b.date) - dnum(a.date));
      setPast(withPhoto.slice(0, 30));
    } catch {
      if (my === seq.current) {
        setPast([]);
        setPastErr('예전 명세서를 찾지 못했어요');
      }
    }
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

  // 크게 보기용 합친 목록
  const all = useMemo(() => {
    const a: { item: Omit<ScrapItem, 'addedAt'>; data?: ViewerData | null }[] = [];
    (home || []).forEach((h) => a.push({ item: homeScrap(h.o, h.hits) }));
    (past || []).forEach((pr) => {
      const k = pastKey(pr.ref_file, pr.ref_invoice_idx);
      const d = pastData[k];
      a.push({ item: pastItem(pr, d?.client), data: d || null });
    });
    return a;
  }, [home, past, pastData]);
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
        <button type="button" className="efb-x" onClick={onClose} aria-label="닫기">
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

  const results = (
    <div className="pf-results">
      <section>
        <h4>
          홈페이지 명세서 {home ? <b>{home.length}</b> : null}
        </h4>
        {home == null ? (
          pending
        ) : home.length === 0 ? (
          <div className="pf-none">{homeErr ? '검색하지 못했어요' : '없어요'}</div>
        ) : (
          <div className="pf-grid">
            {home.map((h, i) => (
              <HomeCard key={h.o.id} h={h} onOpen={() => setDetail(i)} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h4>
          이지폼 예전 명세서 {past ? <b>{past.length}</b> : null}
        </h4>
        {past == null ? (
          pending
        ) : past.length === 0 ? (
          <div className="pf-none">{pastErr || '없어요'}</div>
        ) : (
          <div className="pf-grid">
            {past.map((pr, j) => {
              const k = pastKey(pr.ref_file, pr.ref_invoice_idx);
              return (
                <PastCard
                  key={k}
                  pr={pr}
                  token={token}
                  data={pastData[k]}
                  onData={(d) => setPastData((m) => ({ ...m, [k]: d }))}
                  onOpen={() => setDetail((home?.length || 0) + j)}
                />
              );
            })}
          </div>
        )}
      </section>
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
