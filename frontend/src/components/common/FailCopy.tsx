/**
 * [📋 실패 원인 복사하기] 버튼 + 관리자 화면 아래쪽 '오류가 있었어요' 알림.
 * 내용은 utils/failReport 참고. 화면엔 로그를 안 띄우고 복사만 한다(사용자 2026-11-25).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FAIL_COPY_GUIDE, copyText, isExpectedMiss, onFail, prepareFailReport } from '../../utils/failReport';

export function FailCopyButton({ title, msg = '', className, style }: { title: string; msg?: string; className?: string; style?: CSSProperties }) {
  const rep = useRef<{ text: string } | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    rep.current = prepareFailReport(title, msg);
    setDone(false);
  }, [title, msg]);
  // 못 찾음·취소 같은 정상 결과는 버그가 아니라 버튼 안 띄움(사용자 2026-11-26)
  if (isExpectedMiss(title, msg)) return null;
  return (
    <button
      type="button"
      className={className}
      style={className ? style : { ...BTN, ...style }}
      onClick={() => {
        copyText((rep.current || prepareFailReport(title, msg)).text);
        setDone(true);
      }}
      title={FAIL_COPY_GUIDE}
    >
      {done ? '✅ 복사했어요 — 카톡에 붙여넣기(Ctrl+V)' : '📋 실패 원인 복사하기'}
    </button>
  );
}

const BTN: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #f59e0b',
  background: '#fffbeb',
  color: '#92400e',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

/** 관리자·현장 화면 — 오류가 기록되면 왼쪽 아래에 30초간 작은 알림 + 복사 버튼. */
export function FailCopyChip() {
  const [last, setLast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () =>
      onFail((e) => {
        // 개발 중 React 경고 같은 잡음은 빼고, 실패로 보이는 것만
        if (/^Warning:|React does not recognize|validateDOMNesting|act\(/.test(e.text)) return;
        // 워처·현장 에이전트 탐지(꺼진 PC 에선 늘 실패)는 실패 알림 아님
        if (/127\.0\.0\.1|localhost:(5577|17345)/.test(e.text)) return;
        setLast(e.text.split('\n')[0].slice(0, 120));
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setLast(null), 30000);
      }),
    [],
  );
  if (!last) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: 9000,
        maxWidth: 'min(420px, calc(100vw - 32px))',
        background: '#ffffff',
        color: '#111827',
        border: '1px solid #fcd34d',
        borderRadius: 12,
        boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
        padding: '10px 12px',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ color: '#b45309' }}>⚠ 뭔가 실패했어요</b>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setLast(null)}
          aria-label="닫기"
          style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#6b7280', fontSize: 15 }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: '#4b5563', margin: '2px 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{last}</div>
      <FailCopyButton title="화면에서 오류" msg={last} />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{FAIL_COPY_GUIDE}</div>
    </div>
  );
}
