import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../../context/AuthContext.jsx';
import AutoQuote from './AutoQuote';
import { __resetAutoQuoteCache } from './data/corpusClient';

// Behavioral test: drives the 자동견적 manual-entry UI end-to-end and asserts the
// OBSERVABLE outcome (a priced line with a concrete price + evidence, a VAT-inclusive
// grand total, and the coat-warning when 도수 is implausible). The confidential corpus
// is served only over the (mocked) JWT endpoints — never bundled.

const CORPUS = {
  _meta: { lineCount: 1 },
  lines: [
    {
      category: '갈바·스텐·채널·후렘',
      normName: '채널간판',
      spec: '3000*600',
      qty: 1,
      unitPrice: 540000,
      width: 3000,
      height: 600,
      client: '㈜대한사인',
      date: '2026-01-01',
    },
  ],
};
const PRIORS = { sizeBuckets: {} };

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/priors') ? PRIORS : CORPUS;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('AutoQuote — 자동견적 manual-entry tab (slice 1)', () => {
  beforeEach(() => {
    __resetAutoQuoteCache();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the corpus from the JWT backend, prices a manual line with evidence, and shows a VAT-inclusive grand total', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AutoQuote />
      </AuthProvider>,
    );

    // corpus is fetched from the protected endpoint, not a bundled asset.
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/autoquote/corpus'),
        expect.anything(),
      );
    });

    await user.selectOptions(screen.getByLabelText(/카테고리/), '채널간판');
    await user.clear(screen.getByLabelText(/가로/));
    await user.type(screen.getByLabelText(/가로/), '3000');
    await user.clear(screen.getByLabelText(/세로/));
    await user.type(screen.getByLabelText(/세로/), '600');
    await user.type(screen.getByLabelText(/도수|도장/), '2');
    await user.click(screen.getByRole('button', { name: '추가' }));

    const line = await screen.findByTestId('quote-line');
    // a concrete, non-zero price is shown
    expect(within(line).getByTestId('line-price')).toHaveTextContent(/₩\s?[1-9][\d,]*/);
    // every non-discount line carries >= 1 evidence chip
    expect(within(line).getAllByTestId('evidence-chip').length).toBeGreaterThan(0);
    // a "왜 이 가격" explanation is available
    expect(within(line).getByTestId('why-expand')).toBeInTheDocument();
    // VAT-inclusive grand total is rendered and non-zero
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/₩\s?[1-9][\d,]*/);
  });

  it('treats 도수 90 as a bend angle: shows a coat-warning and does not balloon the price', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AutoQuote />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/corpus'),
        expect.anything(),
      ),
    );

    await user.type(screen.getByLabelText(/가로/), '1000');
    await user.type(screen.getByLabelText(/세로/), '500');
    await user.type(screen.getByLabelText(/도수|도장/), '90');
    await user.click(screen.getByRole('button', { name: '추가' }));

    const line = await screen.findByTestId('quote-line');
    expect(within(line).getByTestId('coat-warning')).toBeInTheDocument();
    // 1000×500 channel size curve = 88000 + 1490·50 = 162,500 (no 90-coat balloon).
    expect(within(line).getByTestId('line-price')).toHaveTextContent('₩162,500');
  });
});
