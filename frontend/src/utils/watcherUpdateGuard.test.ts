// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const W = 'http://127.0.0.1:5577/easyform/bulk';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('watcherUpdateGuard', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as unknown as { __hdWatcherGuard?: boolean }).__hdWatcherGuard;
    document.body.innerHTML = '';
  });

  it('업데이트 중(503) → 연결 끊김 → 새 워처 응답: 호출부엔 정상 응답, 알림은 떴다가 사라짐', async () => {
    // 실측 순서(2026-11-26): 503 updating ×N → 연결 끊김 1번 → 200
    const seq: Array<() => Response> = [
      () => json(503, { updating: true }),
      () => json(503, { updating: true }),
      () => { throw new TypeError('Failed to fetch'); },
      () => json(200, { ok: true, v: 'new' }),
    ];
    let toastSeen = false;
    const fake = vi.fn(async () => {
      if (document.getElementById('hd-watcher-updating')) toastSeen = true;
      return seq.shift()!();
    });
    window.fetch = fake as unknown as typeof fetch;
    const { installWatcherUpdateGuard } = await import('./watcherUpdateGuard');
    installWatcherUpdateGuard();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100); // 호출부의 짧은 타임아웃 — 업데이트 중이면 무시돼야
    const res = await window.fetch(W, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, v: 'new' });
    expect(toastSeen).toBe(true);
    expect(document.getElementById('hd-watcher-updating')).toBeNull();
    expect(fake).toHaveBeenCalledTimes(4);
  }, 10_000);

  it('워처가 그냥 꺼져 있으면 한 번만 더 해보고 원래 오류', async () => {
    const fake = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    window.fetch = fake as unknown as typeof fetch;
    const { installWatcherUpdateGuard } = await import('./watcherUpdateGuard');
    installWatcherUpdateGuard();
    await expect(window.fetch(W)).rejects.toThrow('Failed to fetch');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('워처가 아닌 요청은 그대로', async () => {
    const fake = vi.fn(async () => json(503, { updating: true }));
    window.fetch = fake as unknown as typeof fetch;
    const { installWatcherUpdateGuard } = await import('./watcherUpdateGuard');
    installWatcherUpdateGuard();
    const res = await window.fetch('https://api.example.com/x');
    expect(res.status).toBe(503);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
