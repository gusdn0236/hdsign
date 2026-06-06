import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { lookupPricesMerged, similarCodes, evidence as fetchEvidence } from '../autoquote/annot/api';
import type { Evidence, CodeSuggestion } from '../autoquote/annot/api';
import { matchCodes, didYouMean } from '../autoquote/itemCodes';
import { sizev } from '../autoquote/annot/calc';
import '../autoquote/AutoQuote.css'; // 모달(.aq-modal)·드롭다운(.aq-acdrop) 스타일 재사용
import './PriceLookup.css';

interface Ref {
  reason: string;
  src: string;
  price: number;
  evidence: Evidence | null;
  date?: string; // 후보 명세서 날짜
  cspec?: string; // 후보 규격
  est?: number | null; // 입력 사이즈 기준 예상 단가
}

/** 날짜 'YYYY.MM.DD' → '2022년 2월'. */
function ymLabel(d?: string): string {
  if (!d) return '';
  const m = String(d).match(/(\d{4})\D+(\d{1,2})/);
  return m ? `${m[1]}년 ${parseInt(m[2], 10)}월` : String(d);
}

/** 후보 단가(price, 후보규격 refSpec)를 입력규격(userSpec)으로 면적비 보정(√, 0.5~2.0 clamp). */
function estForSize(price: number, refSpec?: string, userSpec?: string): number | null {
  const rs = sizev(refSpec || '');
  const qs = sizev(userSpec || '');
  if (!rs || !qs || rs <= 0) return null;
  const f = Math.max(0.5, Math.min(2.0, Math.sqrt(qs / rs)));
  return Math.round(price * f);
}
interface LkState {
  refs: Ref[];
  ri: number;
  lpi: number;
  q: string;
}

/**
 * 단가계산기 상단 '단가 찾아보기' — 품목코드 + 규격(+거래처)으로 과거 명세서·지시서에서 단가를 검색.
 * 자동견적 모달과 같은 백엔드(predict/lookup + evidence)를 쓰되, 적용 대신 '복사' 한다(독립 페이지).
 */
export default function PriceLookup() {
  const { token } = useAuth();
  const [code, setCode] = useState(''); // 품목코드 입력칸 텍스트(아직 태그 안 됨)
  const [codes, setCodes] = useState<string[]>([]); // 확정된 품목코드 필터 태그들
  const [spec, setSpec] = useState('');
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const [acOpen, setAcOpen] = useState(false);
  const [acIdx, setAcIdx] = useState(-1); // 품목코드 드롭다운 하이라이트(-1=없음)
  const [lk, setLk] = useState<LkState | null>(null);
  const [msg, setMsg] = useState('');
  const [sugg, setSugg] = useState<CodeSuggestion[]>([]); // 비슷한 코드 추천 칩(같은 물건 다른 표기/오타)

  // 품목코드 태그 추가/삭제. 같은 코드 중복은 무시.
  const addTag = (c: string) => {
    const t = c.trim();
    if (!t) return;
    setCodes((cs) => (cs.includes(t) ? cs : [...cs, t]));
    setCode('');
    setAcOpen(false);
    setAcIdx(-1);
  };
  const removeTag = (t: string) => setCodes((cs) => cs.filter((x) => x !== t));
  // 추천 칩 클릭 = 태그 추가 후 즉시 재검색.
  const onSugg = (c: string) => {
    if (codes.includes(c)) return;
    const next = [...codes, c];
    setCodes(next);
    run(next);
  };

  const run = async (codesOverride?: string[]) => {
    // 확정 태그가 있으면 그 코드들로, 없으면 입력칸 텍스트를 단일 코드로(하위호환).
    const tags = codesOverride ?? codes;
    const active = tags.length ? tags : code.trim() ? [code.trim()] : [];
    if (!active.length && !spec.trim()) {
      setMsg('품목코드 또는 규격을 입력하세요.');
      return;
    }
    setBusy(true);
    setAcOpen(false);
    setMsg('');
    try {
      // 여러 코드 후보를 합쳐 ① 사이즈 근접도(정확일치=1.0) ② 같은 거래처 우선으로 정렬(공용 헬퍼).
      const merged = await lookupPricesMerged(token, client, active, spec, '', { limit: 50 });
      if (merged == null) {
        setMsg('학습 데이터(코퍼스)가 서버에 아직 없습니다.');
        setBusy(false);
        return;
      }
      const refs: Ref[] = await Promise.all(
        merged.map(async (pr) => {
          let ev: Evidence | null = null;
          try {
            ev = await fetchEvidence(token, pr.ref_invoice_idx, pr.ref_file);
          } catch {
            ev = null;
          }
          return {
            reason: pr.reason,
            src: pr.src,
            price: pr.price,
            evidence: ev,
            date: pr.date,
            cspec: pr.size,
            est: estForSize(pr.price, pr.size, spec),
          };
        }),
      );
      const codeLabel = active.length ? active.join(' + ') : '품목';
      const q = `"${codeLabel}${spec ? ' / ' + spec : ''}"${client ? ' · ' + client : ''}`;
      setLk({ refs, ri: 0, lpi: 0, q });
      if (!refs.length) setMsg('관련 과거 단가를 찾지 못했습니다.');
      // 비슷한 코드 추천(같은 물건 다른 표기/오타) — 이미 태그된 건 제외.
      const nrm = (s: string) => s.trim().replace(/[\s/]/g, '').toUpperCase();
      const activeN = new Set(active.map(nrm));
      const lists = await Promise.all(active.filter(Boolean).map((c) => similarCodes(token, c, 8)));
      const seen = new Set<string>();
      setSugg(
        lists
          .flat()
          .filter((x) => {
            const k = nrm(x.code);
            if (activeN.has(k) || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, 10),
      );
    } catch (e) {
      console.error(e);
      setMsg('단가 조회에 실패했습니다.');
    }
    setBusy(false);
  };

  const ms = acOpen && code.trim() ? matchCodes(code).filter((c) => !codes.includes(c)) : [];
  const dym = ms.length ? didYouMean(code, ms) : null;

  // 품목코드 칸 키 — 드롭다운 탐색(↓↑)/Esc. Enter=태그 추가(있으면). 빈칸 Enter=검색. 빈칸 Backspace=마지막 태그 삭제.
  const onCodeKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code && codes.length) {
      removeTag(codes[codes.length - 1]);
      return;
    }
    const m = matchCodes(code).filter((c) => !codes.includes(c));
    if (acOpen && m.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIdx((i) => Math.min(i + 1, m.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIdx((i) => Math.max(i - 1, -1));
        return;
      }
      if (e.key === 'Escape') {
        setAcOpen(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const d = didYouMean(code, m);
        if (acIdx >= 0 && m[acIdx]) {
          addTag(m[acIdx]);
          return;
        }
        if (d) {
          addTag(d);
          return;
        }
        addTag(code);
        return;
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (code.trim()) addTag(code);
      else run();
    }
  };

  return (
    <div className="pl-card">
      <div className="pl-head">
        <span className="pl-title">🔎 단가 찾아보기</span>
        <span className="pl-sub">이지폼에 있는 예전 단가를 찾아드립니다</span>
      </div>
      <div className="pl-form">
        <div className="pl-field pl-code">
          <label>
            품목코드 <span className="pl-hint">Enter로 여러 개 추가 — 같은 물건 다른 코드도 함께 검색</span>
          </label>
          {codes.length > 0 && (
            <div className="pl-tags">
              {codes.map((c) => (
                <span key={c} className="pl-tag">
                  {c}
                  <button type="button" onClick={() => removeTag(c)} aria-label={`${c} 삭제`}>
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="pl-tags-clear" onClick={() => setCodes([])}>
                초기화
              </button>
            </div>
          )}
          <input
            value={code}
            onChange={(e) => {
              const v = e.target.value;
              setCode(v);
              setAcOpen(true);
              const m = matchCodes(v).filter((c) => !codes.includes(c));
              const d = didYouMean(v, m);
              setAcIdx(d ? m.indexOf(d) : -1);
            }}
            onFocus={() => setAcOpen(true)}
            onBlur={() => setTimeout(() => setAcOpen(false), 150)}
            onKeyDown={onCodeKey}
            placeholder={codes.length ? '코드 더 추가… (Enter)' : '예: 갈바레이저타공 (Enter로 추가)'}
          />
          {ms.length > 0 && (
            <div className="aq-acdrop" style={{ position: 'absolute', top: '100%', left: 0, width: '100%', zIndex: 50 }}>
              {dym && acIdx === ms.indexOf(dym) && (
                <div className="aq-achint">
                  혹시 <b>{dym}</b> 인가요? · Enter 적용
                </div>
              )}
              <div className="aq-aclist">
                {ms.map((c, k) => (
                  <div
                    key={c}
                    className={'aq-acitem' + (k === acIdx ? ' on' : '')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(c);
                    }}
                  >
                    {c}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="pl-field">
          <label>규격</label>
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="예: h:100 또는 100*50"
          />
        </div>
        <div className="pl-field">
          <label>거래처 (선택)</label>
          <input
            value={client}
            onChange={(e) => setClient(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="거래처명"
          />
        </div>
        <button className="pl-btn" onClick={() => run()} disabled={busy}>
          {busy ? '조회 중…' : '검색'}
        </button>
      </div>
      {sugg.length > 0 && (
        <div className="pl-sugg">
          <span className="pl-sugg-label">혹시 이걸 찾으시나요?</span>
          {sugg.map((s) => (
            <button key={s.code} type="button" className="pl-sugg-chip" onClick={() => onSugg(s.code)}>
              {s.code} <em>{s.count}건</em>
            </button>
          ))}
        </div>
      )}
      {msg && <div className="pl-msg">{msg}</div>}

      {lk && (
        <LookupResult
          lk={lk}
          setLk={setLk}
          searchCodes={codes.length ? codes : code.trim() ? [code.trim()] : []}
          userSpec={spec}
        />
      )}
    </div>
  );
}

function LookupResult({
  lk,
  setLk,
  searchCodes,
  userSpec,
}: {
  lk: LkState;
  setLk: (f: (l: LkState | null) => LkState | null) => void;
  searchCodes: string[];
  userSpec: string;
}) {
  const close = () => setLk(() => null);
  const num = (v: unknown) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // 키보드 ← → 로 후보 넘기기, Esc 닫기 (입력칸 포커스 중이면 무시).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setLk((l) => (l && l.ri > 0 ? { ...l, ri: l.ri - 1, lpi: 0 } : l));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setLk((l) => (l && l.ri < l.refs.length - 1 ? { ...l, ri: l.ri + 1, lpi: 0 } : l));
      } else if (e.key === 'Escape') {
        setLk(() => null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLk]);
  const ncode = (s: string) => (s || '').trim().replace(/[\s/]/g, '').toUpperCase();
  const R = lk.refs[lk.ri];
  const ev = R?.evidence;
  const phs =
    ev?.photos && ev.photos.length
      ? ev.photos
      : ev?.photo_base64
        ? [{ content_type: ev.photo_content_type || 'image/jpeg', base64: ev.photo_base64 }]
        : [];
  const cur = phs.length ? phs[Math.min(lk.lpi, phs.length - 1)] : null;
  const photo = cur ? `data:${cur.content_type || 'image/jpeg'};base64,${cur.base64}` : null;
  const copyPrice = (p: number) => {
    navigator.clipboard?.writeText(String(p));
  };

  return (
    <div className="aq-modal on pl-modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="aq-mbox">
        <div className="aq-mhead">
          <b>단가 찾아보기</b>
          <span className="aq-q">{lk.q} · 예측 단가·근거</span>
          <span className="aq-nav">
            <button onClick={() => setLk((l) => (l && l.ri > 0 ? { ...l, ri: l.ri - 1, lpi: 0 } : l))}>‹</button>
            <span style={{ fontSize: 12.5, color: '#6b7785' }}>
              {lk.refs.length ? `${lk.ri + 1} / ${lk.refs.length}` : '0'}
            </span>
            <button onClick={() => setLk((l) => (l && l.ri < l.refs.length - 1 ? { ...l, ri: l.ri + 1, lpi: 0 } : l))}>
              ›
            </button>
            <button className="aq-x" onClick={close}>
              ×
            </button>
          </span>
        </div>
        {!lk.refs.length ? (
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
                <div className="pl-gal">
                  <button onClick={() => setLk((l) => (l ? { ...l, lpi: l.lpi > 0 ? l.lpi - 1 : phs.length - 1 } : l))}>
                    ‹
                  </button>
                  <span>
                    지시서 {Math.min(lk.lpi, phs.length - 1) + 1} / {phs.length}
                  </span>
                  <button onClick={() => setLk((l) => (l ? { ...l, lpi: l.lpi < phs.length - 1 ? l.lpi + 1 : 0 } : l))}>
                    ›
                  </button>
                </div>
              )}
            </div>
            <div className="aq-mright">
              <div className="aq-rinfo">
                과거 단가 <b>{Number(R.price).toLocaleString()}원</b>
                <span className="samebadge">{R.src}</span>
                {R.date && <span className="pl-date">{ymLabel(R.date)}</span>}
              </div>
              {R.est != null && (
                <div className="pl-est">
                  입력 사이즈{userSpec ? ` (${userSpec})` : ''} 예상 <b>~{R.est.toLocaleString()}원</b>
                  {R.cspec ? <span className="pl-est-base"> · 근거 규격 {R.cspec}</span> : null}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#6b7785', margin: '6px 0' }}>{R.reason}</div>
              <button className="aq-btn sh" style={{ marginBottom: 10 }} onClick={() => copyPrice(R.price)}>
                이 단가 복사 📋
              </button>
              <div style={{ fontSize: 12, color: '#6b7785', marginBottom: 6 }}>과거 명세서 — 단가 참고용</div>
              <table className="aq-rtbl">
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
                  {(ev?.grid || []).map((g, j) => {
                    // 검색한 품목코드(여럿) 중 하나와 같은 행, 또는 예측단가와 일치하는 행을 한눈에 하이라이트.
                    const hit =
                      searchCodes.some((sc) => sc && ncode(g.item_code as string) === ncode(sc)) ||
                      num(g.unit_price) === Math.round(Number(R.price));
                    return (
                      <tr key={j} className={hit ? 'pl-hit' : ''}>
                        <td>{g.item_code}</td>
                        <td>{g.item}</td>
                        <td>{g.spec}</td>
                        <td>{g.qty}</td>
                        <td className="p">{num(g.unit_price)?.toLocaleString() ?? g.unit_price}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
