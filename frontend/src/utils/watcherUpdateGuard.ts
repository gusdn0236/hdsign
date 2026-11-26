/**
 * 사무실 워처 무중단 업데이트(사용자 2026-11-26) — 홈페이지 쪽.
 *
 * 워처가 새 버전으로 바뀌는 몇 초 동안 옛 워처는 모든 요청에 503 {updating:true} 로 답하고, 그다음 아주 잠깐
 * 포트가 비었다가 새 워처가 이어받는다. 이 가드는 window.fetch 를 감싸 **워처(127.0.0.1:5577) 요청만**:
 *   - 503 updating / 연결 끊김(업데이트 중으로 본 직후) 이면 화면 위에 '업데이트 중이에요' 알림을 띄우고
 *   - 새 워처가 답할 때까지 기다렸다가 **같은 요청을 다시 보내** 원래 호출부에는 정상 응답을 돌려준다.
 * 호출부가 짧은 타임아웃(AbortController ~1.5초)을 걸어 둬도, 업데이트 중으로 확인된 뒤에는 그 신호 없이 기다린다
 * (안 그러면 '워처가 꺼져 있어요'로 잘못 보임). 최대 90초.
 */

const WATCHER_RE = /^http:\/\/(127\.0\.0\.1|localhost):5577(\/|$)/;
const MAX_WAIT_MS = 90_000;
const TOAST_ID = 'hd-watcher-updating';

let lastUpdatingAt = 0;
let waiting = 0;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isUpdating503(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const j = await res.clone().json();
    return !!(j && j.updating);
  } catch {
    return false;
  }
}

function showToast() {
  if (document.getElementById(TOAST_ID)) return;
  const el = document.createElement('div');
  el.id = TOAST_ID;
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed', 'top:18px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
    'background:#1e3a8a', 'color:#fff', 'padding:12px 18px', 'border-radius:12px',
    'box-shadow:0 10px 30px rgba(0,0,0,.25)', 'font:600 14px/1.45 "Malgun Gothic",system-ui,sans-serif',
    'display:flex', 'align-items:center', 'gap:12px', 'max-width:calc(100vw - 32px)',
  ].join(';');
  const spin = document.createElement('span');
  spin.style.cssText =
    'width:18px;height:18px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;' +
    'flex:none;animation:hdWatcherSpin .8s linear infinite';
  const txt = document.createElement('span');
  txt.innerHTML =
    '워처를 새 버전으로 바꾸는 중이에요. 잠시만요.<br>' +
    '<span style="font-weight:400;opacity:.85">끝나면 하던 작업을 그대로 이어서 해요.</span>';
  if (!document.getElementById(TOAST_ID + '-kf')) {
    const st = document.createElement('style');
    st.id = TOAST_ID + '-kf';
    st.textContent = '@keyframes hdWatcherSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
  el.append(spin, txt);
  document.body.appendChild(el);
}

function hideToast() {
  if (waiting > 0) return;
  document.getElementById(TOAST_ID)?.remove();
}

export function installWatcherUpdateGuard(): void {
  if (typeof window === 'undefined' || (window as unknown as { __hdWatcherGuard?: boolean }).__hdWatcherGuard) return;
  (window as unknown as { __hdWatcherGuard?: boolean }).__hdWatcherGuard = true;
  const orig = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!WATCHER_RE.test(urlOf(input))) return orig(input, init);
    const again = () => (input instanceof Request ? input.clone() : input);
    let cur: RequestInit | undefined = init;
    const t0 = Date.now();
    let counted = false;
    let retriedGap = false;
    try {
      for (;;) {
        let res: Response | null = null;
        let err: unknown = null;
        try {
          res = await orig(again(), cur);
        } catch (e) {
          err = e;
        }
        const upd = res ? await isUpdating503(res) : false;
        if (upd) lastUpdatingAt = Date.now();
        const recent = Date.now() - lastUpdatingAt < 60_000;
        // 업데이트 중이 아니면 그대로 — 단, 연결이 끊긴 게 '업데이트 중으로 본 직후'면 기다림
        if (!upd && !(err && recent)) {
          // 포트가 아주 잠깐 비는 순간(503 을 못 보고 바로 끊김)을 위해 연결 실패면 한 번만 0.4초 뒤 다시
          if (err && !retriedGap && !(cur?.signal?.aborted)) {
            retriedGap = true;
            await sleep(400);
            continue;
          }
          if (err) throw err;
          return res as Response;
        }
        if (Date.now() - t0 > MAX_WAIT_MS) {
          if (err) throw err;
          return res as Response;
        }
        if (!counted) {
          counted = true;
          waiting += 1;
        }
        showToast();
        // 업데이트 중 확인 → 호출부의 짧은 타임아웃 신호는 빼고 기다린다
        if (cur?.signal) {
          const { signal: _drop, ...rest } = cur;
          void _drop;
          cur = rest;
        }
        await sleep(700);
      }
    } finally {
      if (counted) waiting -= 1;
      hideToast();
    }
  };
}
