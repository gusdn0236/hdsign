import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { AuthProvider } from '../../../context/AuthContext.jsx';
import AutoQuote from './AutoQuote';
import { __resetAutoQuoteCache } from './data/corpusClient';

// @slice-4 behavioral tests: the OPTIONAL local-agent easyform fill.
//
//  (a) agent ABSENT (probe rejected/aborted) → the 'easyform 자동기입' action is NOT in
//      the DOM at all (HIDDEN, not merely disabled) — matches the acceptance spec's
//      `toHaveCount(0)` assertion.
//  (b) agent PRESENT (probe ok) → the action renders; clicking it opens a preview that
//      maps each approved priced line to the correct {item_code,item,spec,qty,unit_price}
//      cells; '셀 채우기' POSTs { rows } to /easyform/fill; the serialized request body
//      contains NO VK_RETURN / ENTER / RETURN / SAVE / 저장 / commit token (IRON LAW,
//      anti-scenario 7); and `easyform-fill-done` appears on success.
//  (c) the '저장' affordance stays present but DISABLED — a human commits in easyform.
//
// The confidential corpus is served only over the (mocked) JWT endpoints, and the local
// agent is probed/filled only over 127.0.0.1:17345 — exactly as in production.

const CORPUS = {
  _meta: { lineCount: 1 },
  lines: [
    {
      category: '아크릴',
      normName: '아크릴 평판 900*600',
      spec: '900*600',
      qty: 1,
      unitPrice: 78000,
      width: 900,
      height: 600,
      client: '세종디자인',
      date: '2025-09-03',
    },
  ],
};
const PRIORS = { sizeBuckets: {} };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface FillCall {
  body: string;
  parsed: Record<string, unknown>;
}

/**
 * A fetch mock covering BOTH the JWT backend (corpus/priors/corrections) and the local
 * agent (127.0.0.1:17345). When `agent` is false the probe REJECTS (connection refused),
 * mirroring a PC without the agent installed. Fill calls are captured for the IRON LAW
 * assertion.
 */
function makeMock({ agent }: { agent: boolean }) {
  const fills: FillCall[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/easyform/probe')) {
      if (!agent) throw new Error('connection refused'); // no local agent on this PC
      return new Response('{"present":true}', { status: 200, headers: JSON_HEADERS });
    }
    if (url.includes('/easyform/fill')) {
      const body = String(init?.body ?? '');
      fills.push({ body, parsed: JSON.parse(body || '{}') });
      return new Response('{"filled":true}', { status: 200, headers: JSON_HEADERS });
    }
    if (url.includes('/corrections')) {
      return new Response('[]', { status: 200, headers: JSON_HEADERS });
    }
    const body = url.includes('/priors') ? PRIORS : CORPUS;
    return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
  });

  return { fetchMock, fills };
}

/** Fill the manual-entry form and click 추가 (channel sign, sized 1000×500, qty 2). */
async function addChannelLine(user: UserEvent): Promise<void> {
  await user.selectOptions(screen.getByLabelText(/카테고리/), '채널간판');
  const wEl = screen.getByLabelText(/가로/);
  await user.clear(wEl);
  await user.type(wEl, '1000');
  const hEl = screen.getByLabelText(/세로/);
  await user.clear(hEl);
  await user.type(hEl, '500');
  const qEl = screen.getByLabelText(/수량/);
  await user.clear(qEl);
  await user.type(qEl, '2');
  await user.click(screen.getByRole('button', { name: '추가' }));
}

function renderTab() {
  return render(
    <AuthProvider>
      <AutoQuote />
    </AuthProvider>,
  );
}

const easyformBtn = () =>
  screen.queryByRole('button', { name: /easyform 자동기입/ });

describe('AutoQuote — @slice-4 optional local easyform fill', () => {
  beforeEach(() => {
    __resetAutoQuoteCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) HIDES the easyform action entirely when the local agent is absent (probe rejected)', async () => {
    const { fetchMock } = makeMock({ agent: false });
    vi.stubGlobal('fetch', fetchMock);
    renderTab();

    // The corpus still loads (so the tab is fully mounted), but the probe failed.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/easyform/probe'),
        expect.anything(),
      ),
    );
    // Give any state update a chance to flush, then assert the action is NOT rendered.
    await waitFor(() =>
      expect(screen.queryByTestId('easyform-agent-badge')).toBeNull(),
    );
    expect(easyformBtn()).toBeNull();
  });

  it('(b) PRESENT agent → maps lines to cells, POSTs FILL-ONLY rows (no Enter/Save token), shows fill-done', async () => {
    const { fetchMock, fills } = makeMock({ agent: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderTab();

    // Probe succeeded → the action renders.
    await waitFor(() => expect(easyformBtn()).not.toBeNull());
    expect(screen.getByTestId('easyform-agent-badge')).toBeInTheDocument();

    // Approve a priced line, then open the fill preview.
    await addChannelLine(user);
    await screen.findByTestId('quote-line');
    await user.click(easyformBtn()!);

    // The preview maps the priced line to the correct cells.
    const previewRow = await screen.findByTestId('easyform-row');
    expect(within(previewRow).getByTestId('ef-item-code')).toHaveTextContent('AQ-1');
    expect(within(previewRow).getByTestId('ef-item')).toHaveTextContent('채널간판');
    expect(within(previewRow).getByTestId('ef-spec')).toHaveTextContent('1000x500');
    expect(within(previewRow).getByTestId('ef-qty')).toHaveTextContent('2');
    // unit price is a concrete, non-zero won amount.
    expect(within(previewRow).getByTestId('ef-unit-price')).toHaveTextContent(
      /₩\s?[1-9][\d,]*/,
    );

    // Fire the fill.
    await user.click(screen.getByRole('button', { name: /셀 채우기/ }));
    await screen.findByTestId('easyform-fill-done');

    // Exactly one FILL-ONLY POST hit the local agent.
    expect(fills).toHaveLength(1);
    const { body, parsed } = fills[0];

    // The body carries the mapped rows...
    expect(Array.isArray(parsed.rows)).toBe(true);
    const rows = parsed.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].item_code).toBe('AQ-1');
    expect(rows[0].item).toBe('채널간판');
    expect(String(rows[0].spec)).toContain('1000x500');
    expect(rows[0].qty).toBe(2);
    expect(typeof rows[0].unit_price).toBe('number');
    expect(rows[0].unit_price as number).toBeGreaterThan(0);

    // IRON LAW (anti-scenario 7): the request must NOT request a commit in any form.
    expect('keys' in parsed).toBe(false); // no key-sequence directive at all
    expect('save' in parsed).toBe(false);
    expect('commit' in parsed).toBe(false);
    expect(body.toUpperCase()).not.toMatch(/VK_RETURN|ENTER|RETURN|SAVE/);
    expect(body).not.toMatch(/저장|commit/i);
  });

  it('(c) keeps the 저장 affordance present but LOCKED (disabled) — a human commits in easyform', async () => {
    const { fetchMock } = makeMock({ agent: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderTab();

    await waitFor(() => expect(easyformBtn()).not.toBeNull());
    await user.click(easyformBtn()!);

    const saveLock = await screen.findByTestId('easyform-save-locked');
    expect(saveLock).toBeInTheDocument();
    expect(saveLock).toBeDisabled();
  });
});
