import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { lookupPricesMerged, similarCodes, evidence as fetchEvidence, bundle as fetchBundle } from '../autoquote/annot/api';
import type { Evidence, CodeSuggestion, Bundle } from '../autoquote/annot/api';
import { ymdLabel } from '../autoquote/LookupResultModal';
import { matchCodes, didYouMean } from '../autoquote/itemCodes';
import { sizev } from '../autoquote/annot/calc';
import LookupResultModal from '../autoquote/LookupResultModal';
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
  file: string; // 근거 명세서 파일(묶음 조회용)
  invoiceIdx: string | number; // 근거 명세서 idx(묶음 조회용)
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
  bi: number; // 묶음뷰: 0=후보 본인, 1..n=형제 명세서
  q: string;
  total: number; // 사진 있는 후보 총 건수(표시는 최신 30건). "총 N건 찾았습니다"용.
  bundles: Record<number, Bundle | null>; // ri별 묶음(미조회=undefined, 없음=null)
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
  const runSeq = useRef(0); // 검색 세대 — 늦게 도착한 백그라운드 사진이 새 검색을 덮어쓰지 않게.
  const [msg, setMsg] = useState('');
  const [sugg, setSugg] = useState<CodeSuggestion[]>([]); // 비슷한 코드 추천 칩(같은 물건 다른 표기/오타)

  // 품목코드 태그 추가/삭제. 같은 코드 중복은 무시.
  // 모달이 열린 상태(결과 표시 중)면 발주관리처럼 즉시 재검색 — 모달 안 태그바에서 바로 다듬게.
  const addTag = (c: string) => {
    const t = c.trim();
    setCode('');
    setAcOpen(false);
    setAcIdx(-1);
    if (!t || codes.includes(t)) return;
    const next = [...codes, t];
    setCodes(next);
    if (lk) run(next);
  };
  const removeTag = (t: string) => {
    const next = codes.filter((x) => x !== t);
    setCodes(next);
    if (lk) run(next);
  };
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
    const mySeq = ++runSeq.current;
    setBusy(true);
    setAcOpen(false);
    setMsg('');
    try {
      // 여러 코드 후보를 합쳐 ① 사이즈 근접도(정확일치=1.0) ② 같은 거래처 우선으로 정렬(공용 헬퍼).
      const merged = await lookupPricesMerged(token, client, active, spec, '', { limit: 100 });
      if (mySeq !== runSeq.current) return; // 더 새로운 검색이 시작됨 → 폐기
      if (merged == null) {
        setMsg('학습 데이터(코퍼스)가 서버에 아직 없습니다.');
        setBusy(false);
        return;
      }
      // 명세서작성 탭과 같은 기준: ① 매칭 사진 있는 후보만(백엔드 싼 존재확인 photo_available)
      // ② 최신순(날짜 내림차순) ③ 최신 30건만 표시. 사진(evidence)은 무거우니 아직 안 받는다.
      const hasFlag = merged.some((p) => p.photo_available !== undefined);
      const photoed = hasFlag ? merged.filter((p) => p.photo_available) : merged;
      const dnum = (d?: string) => {
        const m = String(d || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
        return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : 0;
      };
      const sorted = [...photoed].sort((a, b) => dnum(b.date) - dnum(a.date));
      const total = sorted.length;
      const top = sorted.slice(0, 30);
      // 명세서(텍스트)만으로 후보 골격을 먼저 만든다(evidence=null → 모달은 "사진 불러오는 중").
      const refs: Ref[] = top.map((pr) => ({
        reason: pr.reason,
        src: pr.src,
        price: pr.price,
        evidence: null,
        date: pr.date,
        cspec: pr.size,
        est: estForSize(pr.price, pr.size, spec),
        file: pr.ref_file,
        invoiceIdx: pr.ref_invoice_idx,
      }));
      const codeLabel = active.length ? active.join(' + ') : '품목';
      const q = `"${codeLabel}${spec ? ' / ' + spec : ''}"${client ? ' · ' + client : ''}`;

      // 무거운 건 사진. 앞 5장만 먼저 받아 모달을 바로 띄우고, 나머지는 사용자가 그 5장을
      // 보는 동안 백그라운드로 채운다(아래). 실패는 null(모달이 "사진 없음" 처리).
      const loadEv = async (r: Ref): Promise<Evidence | null> => {
        try {
          return await fetchEvidence(token, r.invoiceIdx, r.file);
        } catch {
          return null;
        }
      };
      const EAGER = 5;
      const head = await Promise.all(refs.slice(0, EAGER).map(loadEv));
      if (mySeq !== runSeq.current) return;
      head.forEach((ev, i) => {
        refs[i].evidence = ev;
      });
      setLk({ refs, ri: 0, lpi: 0, bi: 0, q, total, bundles: {} });
      setBusy(false);
      if (!refs.length) setMsg('관련 과거 단가를 찾지 못했습니다.');
      // 나머지 사진은 백그라운드로 — 도착하는 대로 해당 후보에 끼워 넣는다(세대 일치할 때만).
      refs.slice(EAGER).forEach((r, k) => {
        const idx = EAGER + k;
        loadEv(r).then((ev) => {
          if (mySeq !== runSeq.current) return;
          setLk((l) => {
            if (!l) return l;
            const next = l.refs.slice();
            if (next[idx]) next[idx] = { ...next[idx], evidence: ev };
            return { ...l, refs: next };
          });
        });
      });
      // 비슷한 코드 추천(같은 물건 다른 표기/오타) — 이미 태그된 건 제외.
      const nrm = (s: string) => s.trim().replace(/[\s/]/g, '').toUpperCase();
      const activeN = new Set(active.map(nrm));
      const lists = await Promise.all(active.filter(Boolean).map((c) => similarCodes(token, c, 8)));
      if (mySeq !== runSeq.current) return; // 새 검색이 시작됨 → 추천칩 갱신 폐기
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

  // 현재 후보의 묶음(형제 명세서)을 lazy 로드·캐시. 후보를 넘길 때마다 안 받은 것만 1회 조회.
  useEffect(() => {
    if (!lk) return;
    const i = lk.ri;
    if (lk.bundles[i] !== undefined) return; // 이미 조회(값 또는 null)
    const ref = lk.refs[i];
    if (!ref) return;
    let cancelled = false;
    fetchBundle(token, ref.invoiceIdx, ref.file)
      .then((b) => !cancelled && setLk((l) => (l ? { ...l, bundles: { ...l.bundles, [i]: b } } : l)))
      .catch(() => !cancelled && setLk((l) => (l ? { ...l, bundles: { ...l.bundles, [i]: null } } : l)));
    return () => {
      cancelled = true;
    };
    // 현재 후보(파일+idx)가 바뀔 때만 반응. 백그라운드 사진이 다른 후보에 끼워져 refs 가
    // 갱신돼도(현 후보 idx 동일) 재실행 안 됨 — 묶음 중복조회 방지.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk?.ri, lk?.refs[lk?.ri ?? 0]?.file, lk?.refs[lk?.ri ?? 0]?.invoiceIdx, token]);

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

      {lk &&
        (() => {
          const sibs = lk.bundles[lk.ri]?.siblings ?? [];
          const bundleCount = 1 + sibs.length;
          const bi = Math.min(lk.bi, bundleCount - 1);
          const bundleEvidence = bi === 0 ? lk.refs[lk.ri]?.evidence ?? null : sibs[bi - 1]?.evidence ?? null;
          const sibEv = bi > 0 ? sibs[bi - 1]?.evidence : null;
          const bundleLabel =
            bi > 0 ? `형제 · ${ymdLabel(sibEv?.date)} ${sibEv?.client ?? ''}`.trim() : undefined;
          return (
            <LookupResultModal
              refs={lk.refs}
              ri={lk.ri}
              lpi={lk.lpi}
              userSpec={spec}
              actionLabel="이 단가 복사 📋"
              pickPrompt="명세서에서 적용하실 가격을 선택해주세요."
              totalFound={lk.total}
              onAction={(p) => navigator.clipboard?.writeText(String(p))}
              onPrev={() => setLk((l) => (l && l.ri > 0 ? { ...l, ri: l.ri - 1, lpi: 0, bi: 0 } : l))}
              onNext={() =>
                setLk((l) => (l && l.ri < l.refs.length - 1 ? { ...l, ri: l.ri + 1, lpi: 0, bi: 0 } : l))
              }
              onClose={() => setLk(null)}
              setLpi={(f) => setLk((l) => (l ? { ...l, lpi: f(l.lpi) } : l))}
              extras={
                <>
                  <div className="aq-lkbar">
                    <span className="aq-lkbar-label">품목코드</span>
                    {codes.map((c) => (
                      <span key={c} className="aq-lktag">
                        {c}
                        <button type="button" onClick={() => removeTag(c)} aria-label={`${c} 삭제`}>
                          ×
                        </button>
                      </span>
                    ))}
                    {codes.length > 0 && (
                      <button
                        type="button"
                        className="aq-lkclear"
                        onClick={() => {
                          setCodes([]);
                          run([]);
                        }}
                      >
                        초기화
                      </button>
                    )}
                    <div className="aq-lkinput">
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
                        placeholder="+ 코드 추가 (Enter) — 같은 물건 다른 코드 함께"
                      />
                      {acOpen &&
                        code.trim() &&
                        (() => {
                          const m = matchCodes(code).filter((c) => !codes.includes(c));
                          if (!m.length) return null;
                          return (
                            <div className="aq-acdrop" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 60 }}>
                              <div className="aq-aclist">
                                {m.map((c, k) => (
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
                          );
                        })()}
                    </div>
                  </div>
                  {sugg.length > 0 && (
                    <div className="aq-lksugg">
                      <span className="aq-lksugg-label">혹시 이걸 찾으시나요?</span>
                      {sugg.map((s) => (
                        <button key={s.code} type="button" className="aq-lksugg-chip" onClick={() => onSugg(s.code)}>
                          {s.code} <em>{s.count}건</em>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              }
              bundleCount={bundleCount}
              bi={bi}
              setBi={(i) => setLk((l) => (l ? { ...l, bi: i, lpi: 0 } : l))}
              bundleEvidence={bundleEvidence}
              bundleLabel={bundleLabel}
            />
          );
        })()}
    </div>
  );
}
