import { useMemo, useRef, useState } from "react";
import { ITEM_CODES, normCode, matchCodes } from "./autoquote/itemCodes";

/**
 * 명세서 탭 '똑똑한 검색창' — 입력 하나에 단서를 아무렇게나 치면 종류를 알아서 정해 칩으로 만든다.
 *   거래처(거래처 목록에 있는 이름) / 품목코드(품목코드 사전) / 규격(숫자×숫자) / 작업키워드(그 외 — 품목칸 글자).
 * 칩을 누르면 종류가 바뀐다(잘못 분류됐을 때). 칩이 바뀌면 부모가 바로 검색한다.
 *
 * 토큰 = {type: 'client'|'code'|'spec'|'text', value}
 */

const TOKEN_TYPES = ["client", "code", "spec", "text"];
const TOKEN_LABEL = { client: "거래처", code: "품목코드", spec: "규격", text: "작업키워드" };

const SPEC_RE = /^\d+(?:\.\d+)?\s*[*x×X]\s*\d+(?:\.\d+)?$/;
const NUM_RE = /^\d+(?:\.\d+)?$/;
const squeeze = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const CODE_SET = new Set(ITEM_CODES.map(normCode));

/** 한 단어의 종류 추정. */
function classify(word, clientIndex) {
  const w = word.trim();
  if (!w) return null;
  if (clientIndex.has(squeeze(w))) return { type: "client", value: clientIndex.get(squeeze(w)) };
  if (CODE_SET.has(normCode(w))) return { type: "code", value: w };
  if (SPEC_RE.test(w)) return { type: "spec", value: w.replace(/\s+/g, "") };
  return { type: "text", value: w };
}

/**
 * 입력 한 줄 → 토큰들. 띄어쓰기로 나누되
 *  - 거래처 이름이 띄어쓰기를 포함하면(예: '나라 광고') 이어지는 단어를 묶어 먼저 맞춰 보고
 *  - '500 100' 처럼 숫자 두 개가 붙어 있으면 규격 하나로 묶는다.
 */
function parseInput(line, clientIndex) {
  const words = String(line || "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    // 거래처 — 최대 3단어까지 묶어서 가장 긴 일치
    let took = 0;
    for (let n = Math.min(3, words.length - i); n >= 2; n--) {
      const joined = words.slice(i, i + n).join("");
      if (clientIndex.has(squeeze(joined))) {
        out.push({ type: "client", value: clientIndex.get(squeeze(joined)) });
        took = n;
        break;
      }
    }
    if (took) { i += took; continue; }
    // 품목코드가 띄어쓰기로 갈라진 경우(예: '아크릴 5t') — 두 단어 붙여서 사전에 있으면 코드 하나로.
    if (i + 1 < words.length && CODE_SET.has(normCode(words[i] + words[i + 1]))) {
      out.push({ type: "code", value: words[i] + words[i + 1] });
      i += 2;
      continue;
    }
    // 숫자 + 숫자 → 규격
    if (NUM_RE.test(words[i]) && i + 1 < words.length && NUM_RE.test(words[i + 1])) {
      out.push({ type: "spec", value: `${words[i]}*${words[i + 1]}` });
      i += 2;
      continue;
    }
    const t = classify(words[i], clientIndex);
    if (t) out.push(t);
    i += 1;
  }
  return out;
}

export default function StatementSmartSearch({
  clientNames,      // 전체 거래처 이름 배열(자동완성·분류용)
  tokens,           // 현재 칩
  onTokens,         // (next) => void
  searching,
  result,           // {items, matches, truncated, tookMs} | null
  recent,           // 최근 검색(토큰 배열들)
  onRemoveRecent,   // (index) => void — 최근 검색 한 줄 삭제
  sort,
  onSort,
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef(null);

  const clientIndex = useMemo(() => {
    const m = new Map();
    (clientNames || []).forEach((n) => { if (n) m.set(squeeze(n), n); });
    return m;
  }, [clientNames]);

  const hasToken = (t) => tokens.some((x) => x.type === t.type && squeeze(x.value) === squeeze(t.value));
  const addTokens = (list) => {
    const next = [...tokens];
    list.forEach((t) => {
      if (!next.some((x) => x.type === t.type && squeeze(x.value) === squeeze(t.value))) next.push(t);
    });
    onTokens(next);
    setInput("");
    setHi(-1);
  };
  const removeAt = (i) => onTokens(tokens.filter((_, j) => j !== i));
  const cycleType = (i) => {
    const t = tokens[i];
    const nt = TOKEN_TYPES[(TOKEN_TYPES.indexOf(t.type) + 1) % TOKEN_TYPES.length];
    onTokens(tokens.map((x, j) => (j === i ? { ...x, type: nt } : x)));
  };

  // 자동완성 — 지금 치고 있는 마지막 단어 기준. 종류를 붙여서 보여준다.
  const lastWord = input.split(/\s+/).pop() || "";
  const suggestions = useMemo(() => {
    const q = lastWord.trim();
    if (!q) return [];
    const sq = squeeze(q);
    const out = [];
    (clientNames || [])
      .filter((n) => squeeze(n).includes(sq))
      .slice(0, 4)
      .forEach((n) => out.push({ type: "client", value: n }));
    matchCodes(q).slice(0, 4).forEach((c) => out.push({ type: "code", value: c }));
    if (SPEC_RE.test(q)) out.push({ type: "spec", value: q.replace(/\s+/g, "") });
    out.push({ type: "text", value: q });
    return out.filter((t) => !hasToken(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWord, clientNames, tokens]);

  const showRecent = open && !input.trim() && recent && recent.length > 0;
  const showSuggest = open && suggestions.length > 0;

  const pickSuggestion = (s) => {
    // 마지막 단어 앞부분(이미 친 다른 단어들)은 자동 분류, 마지막 단어는 고른 종류로.
    const head = input.trim().split(/\s+/).slice(0, -1).join(" ");
    addTokens([...parseInput(head, clientIndex), s]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" && showSuggest) {
      e.preventDefault();
      setHi((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === "ArrowUp" && showSuggest) {
      e.preventDefault();
      setHi((h) => Math.max(-1, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showSuggest && hi >= 0 && suggestions[hi]) pickSuggestion(suggestions[hi]);
      else if (input.trim()) addTokens(parseInput(input, clientIndex));
    } else if (e.key === "Backspace" && !input && tokens.length) {
      e.preventDefault();
      removeAt(tokens.length - 1);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="ss">
      <div className="ss-head">
        <span className="ss-title">명세서 검색</span>
        <span className="ss-hint">
          거래처·품목코드·규격·작업키워드(품목칸 글자)를 띄어쓰기로 이어서 치고 Enter · 칩을 누르면 종류 변경 · 3년치 전체
        </span>
      </div>

      <div className="ss-box-wrap">
        <div
          className={`ss-box${open ? " is-focus" : ""}`}
          onClick={() => inputRef.current?.focus()}
        >
          <span className="ss-icon" aria-hidden>⌕</span>
          {tokens.map((t, i) => (
            <span key={`${t.type}:${t.value}:${i}`} className={`ss-chip ss-chip--${t.type}`}>
              <button
                type="button"
                className="ss-chip-body"
                onClick={(e) => { e.stopPropagation(); cycleType(i); }}
                title={`${TOKEN_LABEL[t.type]} — 클릭하면 종류 변경`}
              >
                <span className="ss-chip-type">{TOKEN_LABEL[t.type]}</span>
                {t.value}
              </button>
              <button
                type="button"
                className="ss-chip-x"
                onClick={(e) => { e.stopPropagation(); removeAt(i); }}
                aria-label={`${t.value} 제거`}
              >×</button>
            </span>
          ))}
          <input
            ref={inputRef}
            className="ss-input"
            value={input}
            onChange={(e) => { setInput(e.target.value); setHi(-1); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKeyDown}
            placeholder={tokens.length ? "" : "예: 나라광고 아크릴5T 500*100 육바연로고"}
          />
          {searching && <span className="ss-spin" aria-label="검색 중" />}
          {(tokens.length > 0 || input) && (
            <button
              type="button"
              className="ss-clear"
              onClick={(e) => { e.stopPropagation(); setInput(""); onTokens([]); }}
              title="검색 전부 지우기"
            >
              초기화
            </button>
          )}
        </div>

        {(showSuggest || showRecent) && (
          <ul className="ss-pop" onMouseDown={(e) => e.preventDefault()}>
            {showSuggest
              ? suggestions.map((s, k) => (
                  <li
                    key={`${s.type}:${s.value}`}
                    className={k === hi ? "is-hi" : ""}
                    onMouseEnter={() => setHi(k)}
                    onClick={() => pickSuggestion(s)}
                  >
                    <span className={`ss-pop-type ss-pop-type--${s.type}`}>{TOKEN_LABEL[s.type]}</span>
                    {s.value}
                  </li>
                ))
              : (
                <>
                  <li className="ss-pop-head">최근 검색</li>
                  {recent.map((r, k) => (
                    <li key={k} className="ss-recent" onClick={() => { onTokens(r); setOpen(false); }}>
                      <span className="ss-recent-chips">
                        {r.map((t, j) => (
                          <span key={j} className={`ss-mini ss-chip--${t.type}`}>{t.value}</span>
                        ))}
                      </span>
                      <button
                        type="button"
                        className="ss-recent-del"
                        onClick={(e) => { e.stopPropagation(); onRemoveRecent?.(k); }}
                        title="이 최근 검색 삭제"
                        aria-label="최근 검색 삭제"
                      >×</button>
                    </li>
                  ))}
                </>
              )}
          </ul>
        )}
      </div>

      {result && <PriceSummary result={result} sort={sort} onSort={onSort} />}
    </div>
  );
}

const toWon = (v) => {
  const n = Number(String(v || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const fmtWon = (n) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const mmdd = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}` : "";
};

/** 결과 맨 위 단가 요약 — 몇 건 · 단가 범위 · 최근 단가(거래처 날짜) + 정렬. */
function PriceSummary({ result, sort, onSort }) {
  const s = useMemo(() => {
    const prices = [];
    let latest = null;
    result.items.forEach((o) => {
      (result.matches[String(o.id)] || []).forEach((r) => {
        const p = toWon(r["단가"]);
        if (p == null) return;
        prices.push(p);
        if (!latest) latest = { p, client: o.clientCompanyName, at: o.createdAt };
      });
    });
    prices.sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
    return { n: result.items.length, rows: prices.length, min: prices[0], max: prices[prices.length - 1], median, latest };
  }, [result]);

  return (
    <div className="ss-sum">
      <span className="ss-sum-main">
        <b>{s.n}건</b>
        {s.rows > 0 ? (
          <>
            <span className="ss-sum-dot">·</span>
            단가 <b>{s.min === s.max ? fmtWon(s.min) : `${fmtWon(s.min)} ~ ${fmtWon(s.max)}`}</b>
            {s.rows >= 3 && <span className="ss-sum-sub"> (중간값 {fmtWon(s.median)})</span>}
            {s.latest && (
              <>
                <span className="ss-sum-dot">·</span>
                최근 <b>{fmtWon(s.latest.p)}</b>
                <span className="ss-sum-sub">
                  {" "}({[s.latest.client, mmdd(s.latest.at)].filter(Boolean).join(" ")})
                </span>
              </>
            )}
          </>
        ) : (
          s.n > 0 && <span className="ss-sum-sub"> · 단가 적힌 행 없음</span>
        )}
        {result.truncated && <span className="ss-sum-warn"> · 결과가 많아 최신 300건까지</span>}
        {result.tookMs != null && <span className="ss-sum-sub"> · {(result.tookMs / 1000).toFixed(2)}초</span>}
      </span>
      <span className="ss-sort">
        {[["recent", "최신순"], ["low", "단가 낮은순"], ["high", "단가 높은순"]].map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={`ss-sort-btn${sort === k ? " is-on" : ""}`}
            onClick={() => onSort(k)}
          >{l}</button>
        ))}
      </span>
    </div>
  );
}
