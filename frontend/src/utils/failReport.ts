/**
 * 실패 원인 복사하기 — 홈페이지·워처에서 뭔가 실패하면 직원이 [실패 원인 복사하기]를 눌러 담당자(현우)에게
 * 카톡으로 붙여넣어 보내게 한다(사용자 2026-11-25). 로그는 화면에 안 띄우고 복사만.
 *
 * 담는 것: 무엇이 실패했나(제목·메시지) + 시각·주소·PC 이름·빌드 + 이 페이지의 최근 오류(console.error·
 * 잡히지 않은 오류) + 이 PC 워처의 이지폼 작업 기록 끝부분(워처가 켜져 있을 때).
 *
 * ⚠ 앞으로 실패를 알리는 화면(창·카드·안내)을 새로 만들면 여기 FailCopyButton / prepareFailReport 를 같이 붙인다.
 */

export interface FailEntry {
  t: string;
  kind: string;
  text: string;
}

const MAX = 60;
const buf: FailEntry[] = [];
const subs = new Set<(e: FailEntry) => void>();
let installed = false;

const WATCHER_URL: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_HDSIGN_WATCHER_URL || 'http://127.0.0.1:5577';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function show(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 6).join('\n')}` : ''}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 실패 기록 1줄 추가(직접 부를 수도 있음). */
export function recordFail(kind: string, ...args: unknown[]): void {
  const text = args.map(show).join(' ').slice(0, 2000);
  if (!text.trim()) return;
  const e = { t: stamp(), kind, text };
  buf.push(e);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  subs.forEach((fn) => {
    try {
      fn(e);
    } catch {
      /* 무시 */
    }
  });
}

/** 앱 시작 때 1번 — console.error·잡히지 않은 오류를 모아 둔다. */
export function installFailCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    recordFail('error', ...args);
    orig(...args);
  };
  window.addEventListener('error', (ev) => recordFail('uncaught', ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => recordFail('promise', ev.reason));
}

export function onFail(fn: (e: FailEntry) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function pcName(): string {
  try {
    return (localStorage.getItem('hdsign_statement_editor_name') || '').trim();
  } catch {
    return '';
  }
}

async function watcherLog(): Promise<{ text: string; pc?: string } | null> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${WATCHER_URL}/easyform/log`, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(to);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 복사할 글 — 창을 띄울 때 미리 만들어 둔다(버튼 누른 순간 바로 복사돼야 브라우저가 안 막음).
 *  반환 객체의 text 는 워처 기록을 받으면 채워진다. */
export function prepareFailReport(title: string, msg = '', extra = ''): { text: string; ready: Promise<void> } {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
  const head = [
    `[HD사인 실패] ${title}`,
    msg ? `메시지: ${msg}` : '',
    extra,
    `시각: ${new Date().toLocaleString('ko-KR')}`,
    `화면: ${typeof location !== 'undefined' ? location.pathname + location.search : '-'}`,
    `PC 이름: ${pcName() || '-'}`,
    `빌드: ${env.VITE_BUILD_SHA || '-'}`,
  ]
    .filter(Boolean)
    .join('\n');
  const recent = buf.slice(-25).map((e) => `${e.t} [${e.kind}] ${e.text}`).join('\n');
  const web = `--- 홈페이지 최근 오류 ---\n${recent || '(없음)'}`;
  const out = { text: `${head}\n\n${web}\n\n(워처 기록을 불러오는 중이었어요)`, ready: Promise.resolve() };
  out.ready = watcherLog().then((l) => {
    out.text =
      `${head}\n\n${web}\n\n` +
      (l
        ? `--- 워처 기록(${l.pc || 'PC'}, 마지막 부분) ---\n${(l.text || '(기록 없음)').split('\n').slice(-150).join('\n')}`
        : '(워처 기록 없음 — 이 PC 에 워처가 꺼져 있거나 옛 버전)');
  });
  return out;
}

/** 클립보드 복사(버튼 클릭 안에서 바로 불러야 함). */
export function copyText(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* 아래로 */
  }
  try {
    void navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const FAIL_COPY_GUIDE = '[실패 원인 복사하기]를 눌러서 담당자(현우)에게 카톡으로 붙여넣어 전달해주세요.';
