import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { lookupPrices, evidence as fetchEvidence } from '../autoquote/annot/api';
import type { Evidence } from '../autoquote/annot/api';
import { matchCodes, didYouMean } from '../autoquote/itemCodes';
import '../autoquote/AutoQuote.css'; // 모달(.aq-modal)·드롭다운(.aq-acdrop) 스타일 재사용
import './PriceLookup.css';

interface Ref {
  reason: string;
  src: string;
  price: number;
  evidence: Evidence | null;
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
  const [code, setCode] = useState('');
  const [spec, setSpec] = useState('');
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const [acOpen, setAcOpen] = useState(false);
  const [acIdx, setAcIdx] = useState(-1); // 품목코드 드롭다운 하이라이트(-1=없음)
  const [lk, setLk] = useState<LkState | null>(null);
  const [msg, setMsg] = useState('');

  const run = async () => {
    if (!code.trim() && !spec.trim()) {
      setMsg('품목코드 또는 규격을 입력하세요.');
      return;
    }
    setBusy(true);
    setAcOpen(false);
    setMsg('');
    try {
      const preds = await lookupPrices(token, client, { text: code, material: code, size: spec, qty: '' }, 12);
      if (preds == null) {
        setMsg('학습 데이터(코퍼스)가 서버에 아직 없습니다.');
        setBusy(false);
        return;
      }
      const refs: Ref[] = await Promise.all(
        preds.map(async (pr) => {
          let ev: Evidence | null = null;
          try {
            ev = await fetchEvidence(token, pr.ref_invoice_idx, pr.ref_file);
          } catch {
            ev = null;
          }
          return { reason: pr.reason, src: pr.src, price: pr.price, evidence: ev };
        }),
      );
      const q = `"${code.trim() || '품목'}${spec ? ' / ' + spec : ''}"${client ? ' · ' + client : ''}`;
      setLk({ refs, ri: 0, lpi: 0, q });
      if (!refs.length) setMsg('관련 과거 단가를 찾지 못했습니다.');
    } catch (e) {
      console.error(e);
      setMsg('단가 조회에 실패했습니다.');
    }
    setBusy(false);
  };

  const ms = acOpen && code.trim() ? matchCodes(code) : [];
  const dym = ms.length ? didYouMean(code, ms) : null;

  // 품목코드 칸 키 — 드롭다운 탐색(↓↑)/선택(Enter)/닫기(Esc). 선택 없으면 Enter=검색 실행.
  const onCodeKey = (e: React.KeyboardEvent) => {
    const m = matchCodes(code);
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
          setCode(m[acIdx]);
          setAcOpen(false);
          return;
        }
        if (d) {
          setCode(d);
          setAcOpen(false);
          return;
        }
        run();
        return;
      }
    } else if (e.key === 'Enter') {
      run();
    }
  };

  return (
    <div className="pl-card">
      <div className="pl-head">
        <span className="pl-title">🔎 단가 찾아보기</span>
        <span className="pl-sub">과거 명세서·작업지시서에서 품목코드 + 사이즈로 실제 단가를 찾아봅니다</span>
      </div>
      <div className="pl-form">
        <div className="pl-field pl-code">
          <label>품목코드</label>
          <input
            value={code}
            onChange={(e) => {
              const v = e.target.value;
              setCode(v);
              setAcOpen(true);
              const m = matchCodes(v);
              const d = didYouMean(v, m);
              setAcIdx(d ? m.indexOf(d) : -1);
            }}
            onFocus={() => setAcOpen(true)}
            onBlur={() => setTimeout(() => setAcOpen(false), 150)}
            onKeyDown={onCodeKey}
            placeholder="예: 갈바레이저타공"
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
                      setCode(c);
                      setAcOpen(false);
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
        <button className="pl-btn" onClick={run} disabled={busy}>
          {busy ? '조회 중…' : '검색'}
        </button>
      </div>
      {msg && <div className="pl-msg">{msg}</div>}

      {lk && <LookupResult lk={lk} setLk={setLk} searchCode={code} />}
    </div>
  );
}

function LookupResult({
  lk,
  setLk,
  searchCode,
}: {
  lk: LkState;
  setLk: (f: (l: LkState | null) => LkState | null) => void;
  searchCode: string;
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
                예측 단가 <b>{Number(R.price).toLocaleString()}원</b>
                <span className="samebadge">{R.src}</span>
              </div>
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
                    // 검색한 품목코드와 같은 행, 또는 예측단가와 일치하는 행을 한눈에 하이라이트.
                    const hit =
                      (!!searchCode && ncode(g.item_code as string) === ncode(searchCode)) ||
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
