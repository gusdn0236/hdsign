import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { AuthProvider } from '../../../context/AuthContext.jsx';
import AutoQuote from './AutoQuote';
import { __resetAutoQuoteCache } from './data/corpusClient';

// @slice-3 behavioral tests: a staffer fixes a quote line's price + writes WHY →
// it POSTs to the corrections API (author set server-side, NOT by the client) →
// a saved toast shows → after a re-fetch the corrected price resurfaces as the TOP
// prior on that line (보정 evidence chip). And a correction already on the server
// surfaces as the top prior for a FRESH session — proving one staffer's correction
// lifts everyone. The corpus is served only over the (mocked) JWT endpoints.

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

interface RawCorrection {
  id: number;
  featureKey: string;
  correctedUnitPrice: number;
  explanation: string;
  author: string;
  priority: number;
  createdAt: string;
}

/**
 * A stateful fetch mock standing in for the JWT backend: corpus/priors are static,
 * and /corrections is a tiny shared store — POST appends (server stamps `author`)
 * and GET returns the current list, so a re-fetch after save sees the new record.
 */
function makeServer(initial: RawCorrection[] = []) {
  const corrections = [...initial];
  const posted: Array<Record<string, unknown>> = [];
  let nextId = initial.length + 1;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/corrections')) {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posted.push(body);
        const saved: RawCorrection = {
          id: nextId++,
          featureKey: String(body.featureKey),
          correctedUnitPrice: Number(body.correctedUnitPrice),
          explanation: String(body.explanation),
          // The server is the source of truth for author (JWT principal) — never the body.
          author: 'admin',
          priority: typeof body.priority === 'number' ? body.priority : 100,
          createdAt: '2026-06-02T00:00:00',
        };
        corrections.unshift(saved);
        return new Response(JSON.stringify(saved), { status: 201, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify(corrections), { status: 200, headers: JSON_HEADERS });
    }

    const body = url.includes('/priors') ? PRIORS : CORPUS;
    return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
  });

  return { fetchMock, posted };
}

function wonNum(el: Element | null): number {
  return parseInt((el?.textContent ?? '').replace(/[^\d]/g, ''), 10);
}
function linePrice(line: HTMLElement): number {
  return wonNum(within(line).getByTestId('line-price'));
}

/** Fill the manual-entry form and click 추가 (channel sign, sized 1000×500). */
async function addChannelLine(user: UserEvent): Promise<void> {
  await user.selectOptions(screen.getByLabelText(/카테고리/), '채널간판');
  const wEl = screen.getByLabelText(/가로/);
  await user.clear(wEl);
  await user.type(wEl, '1000');
  const hEl = screen.getByLabelText(/세로/);
  await user.clear(hEl);
  await user.type(hEl, '500');
  await user.click(screen.getByRole('button', { name: '추가' }));
}

function renderTab() {
  return render(
    <AuthProvider>
      <AutoQuote />
    </AuthProvider>,
  );
}

describe('AutoQuote — @slice-3 shared corrections flow', () => {
  beforeEach(() => {
    __resetAutoQuoteCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('edits a line → POSTs featureKey/price/reason (NO author) → saved toast → corrected top-prior price + 보정 chip', async () => {
    const { fetchMock, posted } = makeServer();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderTab();

    await addChannelLine(user);
    const line = await screen.findByTestId('quote-line');
    const sizeCurvePrice = linePrice(line);
    expect(sizeCurvePrice).toBeGreaterThan(0);

    // Open the inline price-edit form and write the corrected price + WHY.
    await user.click(within(line).getByRole('button', { name: /가격 수정|이유 적기/ }));
    await user.type(within(line).getByTestId('correction-price'), '95000');
    await user.type(within(line).getByTestId('correction-reason'), '야간 시공 할증 포함');
    await user.click(within(line).getByRole('button', { name: /공유 저장/ }));

    // ANTI-FLAKY (job8): the saved toast must appear before the re-fetch/re-quote.
    await screen.findByTestId('correction-saved-toast');

    // The POST carried the engine-shared featureKey + the fields — and NO author.
    const post = posted.at(-1)!;
    expect(post.featureKey).toBe('채널간판::h500');
    expect(Number(post.correctedUnitPrice)).toBe(95000);
    expect(post.explanation).toContain('야간');
    expect('author' in post).toBe(false);

    // After the re-fetch + re-estimate, the line shows the corrected won as the TOP
    // prior and cites it with a 보정/prior evidence chip.
    await waitFor(() => expect(linePrice(screen.getByTestId('quote-line'))).toBe(95000));
    const corrected = screen.getByTestId('quote-line');
    const corrChip = within(corrected)
      .getAllByTestId('evidence-chip')
      .find((c) => /보정|prior/.test(c.textContent ?? ''));
    expect(corrChip).toBeDefined();
  });

  it('surfaces a correction saved by another staffer as the TOP prior for a fresh session (shared)', async () => {
    // A correction already persisted by someone else (server-side, author=박직원).
    const { fetchMock } = makeServer([
      {
        id: 1,
        featureKey: '채널간판::h500',
        correctedUnitPrice: 88000,
        explanation: '거래처 협의 단가',
        author: '박직원',
        priority: 100,
        createdAt: '2026-06-01T09:00:00',
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderTab();

    // Fresh session lazy-fetches corrections on mount, so the same item prices to
    // the shared correction with a 보정/prior chip — no local edit needed.
    await addChannelLine(user);
    const line = await screen.findByTestId('quote-line');
    await waitFor(() => expect(linePrice(screen.getByTestId('quote-line'))).toBe(88000));
    const corrChip = within(line)
      .getAllByTestId('evidence-chip')
      .find((c) => /보정|prior/.test(c.textContent ?? ''));
    expect(corrChip).toBeDefined();
  });
});
