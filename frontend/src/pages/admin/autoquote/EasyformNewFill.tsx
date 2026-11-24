/**
 * 홈페이지 → 이지폼 '새 명세서' 작성 확인 창.
 * 이 홈페이지 거래처를 예전에 이지폼 어느 쪽(주식회사/개인)·어느 거래처로 끊었는지(지문 × 이지폼 목록)를 먼저 골라 둔다.
 * [작성하고 저장] → 워처가 새로작성 → 거래처 선택(사업자번호) → 입력 → 저장.
 * 다른 거래처로 끊을 땐 [직접 고를게요](이지폼에서 사람이 거래처를 고름) — 검색칸은 헷갈려서 뺐다(사용자 2026-11-24).
 */
import { useEffect, useRef, useState } from 'react';
import './EasyformNewFill.css';

export interface EfClientChoice {
  biz: 'corp' | 'personal';
  client: string; // 이지폼 거래처명
  bizNo: string; // 사업자번호 — 이지폼에서 이걸로 정확히 1건 찾는다
  count: number; // 이 홈페이지 거래처로 끊은 횟수(기록) 또는 올해 명세서 수(이름 비슷)
  last: string; // 마지막 발행일 YYYY.MM.DD
}

const bizLabel = (b: string) => (b === 'corp' ? '주식회사' : '개인');
const key = (c: EfClientChoice) => `${c.biz}|${c.bizNo}`;

export default function EasyformNewFill(props: {
  webClient: string;
  rowsCount: number;
  total: number;
  history: EfClientChoice[]; // 예전에 이 거래처로 끊은 기록(많은 순)
  similar: EfClientChoice[]; // 기록 없을 때 이름 비슷한 거래처
  onConfirm: (c: EfClientChoice) => void;
  onManual: () => void;
  onCancel: () => void;
}) {
  const { webClient, rowsCount, total, history, similar, onConfirm, onManual, onCancel } = props;
  const first = history[0] || similar[0] || null;
  const [sel, setSel] = useState<EfClientChoice | null>(first);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const item = (c: EfClientChoice, note: string) => (
    <button
      type="button"
      key={key(c)}
      className={`efnf-item${sel && key(sel) === key(c) ? ' on' : ''}`}
      onClick={() => setSel(c)}
      onDoubleClick={() => onConfirm(c)}
    >
      <span className={`efnf-biz ${c.biz}`}>{bizLabel(c.biz)}</span>
      <span className="efnf-name">{c.client}</span>
      <span className="efnf-no">{c.bizNo}</span>
      <span className="efnf-note">{note}</span>
    </button>
  );

  return (
    <div className="efnf" role="dialog" aria-modal="true" aria-label="이지폼에 새 명세서 작성">
      <div className="efnf-card">
        <header className="efnf-head">
          <h2>이지폼에 새 명세서를 작성할까요?</h2>
          <p>
            홈페이지 거래처 <b>{webClient || '(없음)'}</b> · {rowsCount}줄 · 합계 {total.toLocaleString()}원
          </p>
        </header>
        <div className="efnf-body">
          {history.length > 0 ? (
            <section>
              <p className="efnf-label">예전에 이 거래처를 끊은 이지폼 거래처</p>
              {history.map((c) => item(c, `${c.count}번 · 최근 ${c.last}`))}
            </section>
          ) : (
            <section>
              <p className="efnf-label">
                예전 기록이 없어요{similar.length ? ' — 이름이 비슷한 이지폼 거래처' : ''}
              </p>
              {similar.map((c) => item(c, `올해 ${c.count}건 · 최근 ${c.last}`))}
              {!similar.length && <p className="efnf-empty">[직접 고를게요]를 눌러 이지폼에서 거래처를 골라주세요.</p>}
            </section>
          )}
        </div>
        <footer className="efnf-foot">
          <p className="efnf-pick">
            {sel ? (
              <>
                이지폼 <b>[{bizLabel(sel.biz)}]</b> <b>{sel.client}</b> 에 새로 작성하고 <b>저장까지</b> 해요
              </>
            ) : (
              '이지폼 거래처를 골라주세요'
            )}
          </p>
          <div className="efnf-btns">
            <button type="button" className="sec" onClick={onCancel}>
              취소
            </button>
            <button type="button" className="sec" onClick={onManual} title="이지폼에서 새로작성 → 거래처를 직접 고르면, 나머지 입력과 저장은 자동으로 해요">
              직접 고를게요
            </button>
            <button type="button" ref={okRef} disabled={!sel} onClick={() => sel && onConfirm(sel)}>
              작성하고 저장
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
