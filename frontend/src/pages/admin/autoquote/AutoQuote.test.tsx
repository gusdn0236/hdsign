import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { AuthProvider } from '../../../context/AuthContext.jsx';
import AutoQuote from './AutoQuote';
import { __resetAutoQuoteCache } from './data/corpusClient';

// Behavioral tests: drive the 자동견적 manual-entry UI end-to-end and assert the
// OBSERVABLE outcome (priced lines, evidence, VAT-inclusive totals, coat-warnings,
// low-confidence flags). Assertions are RELATIVE wherever possible (a line vs a
// sibling baseline line) so they prove the engine's *intent* — VAT applied, coats
// surcharged 1..7 only, bend/implausible 도수 never ballooned, brandText is an
// identity filter not a price driver, qty multiplies — rather than pinning a
// particular implementation constant. The confidential corpus is served only over
// the (mocked) JWT endpoints, never bundled.

// Realistic corpus: real past-invoice channel/acrylic lines. None of these share
// enough name with the canonical category query to clear the text-match floor, so
// the manual channel queries below resolve via the size curve (tier ②/③) — which
// keeps the relative assertions stable regardless of fuzzy-match noise.
const CORPUS = {
  _meta: { lineCount: 3 },
  lines: [
    {
      category: '갈바·스텐·채널·후렘',
      normName: '채널간판 3000*600',
      spec: '3000*600',
      qty: 1,
      unitPrice: 540000,
      width: 3000,
      height: 600,
      client: '㈜대한사인',
      date: '2026-01-01',
    },
    {
      category: '갈바·스텐·채널·후렘',
      normName: '채널간판 2000*500',
      spec: '2000*500',
      qty: 1,
      unitPrice: 420000,
      width: 2000,
      height: 500,
      client: '대성광고',
      date: '2025-11-12',
    },
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

/** Parse a ₩-formatted amount ("₩162,500") to an integer won value. */
function wonNum(el: Element | null): number {
  return parseInt((el?.textContent ?? '').replace(/[^\d]/g, ''), 10);
}

/** Read the line-price (integer won) of one quote-line element. */
function linePrice(line: HTMLElement): number {
  return wonNum(within(line).getByTestId('line-price'));
}

interface EntryOpts {
  category?: string;
  w?: number;
  h?: number;
  coats?: number;
  qty?: number;
  brand?: string;
}

/**
 * Fill the manual-entry form and click 추가. Each call fully (re)sets the size and
 * optional fields so successive lines don't inherit stale values (the draft resets
 * everything but the category between adds).
 */
async function addEntry(user: UserEvent, opts: EntryOpts): Promise<void> {
  if (opts.category) {
    await user.selectOptions(screen.getByLabelText(/카테고리/), opts.category);
  }
  const wEl = screen.getByLabelText(/가로/);
  await user.clear(wEl);
  if (opts.w != null) await user.type(wEl, String(opts.w));

  const hEl = screen.getByLabelText(/세로/);
  await user.clear(hEl);
  if (opts.h != null) await user.type(hEl, String(opts.h));

  const coatEl = screen.getByLabelText(/도수|도장/);
  await user.clear(coatEl);
  if (opts.coats != null) await user.type(coatEl, String(opts.coats));

  if (opts.qty != null) {
    const qEl = screen.getByLabelText(/수량/);
    await user.clear(qEl);
    await user.type(qEl, String(opts.qty));
  }

  if (opts.brand != null) {
    const bEl = screen.getByLabelText(/브랜드텍스트/);
    await user.clear(bEl);
    await user.type(bEl, opts.brand);
  }

  await user.click(screen.getByRole('button', { name: '추가' }));
}

function renderTab() {
  return render(
    <AuthProvider>
      <AutoQuote />
    </AuthProvider>,
  );
}

/** Wait until the corpus has been fetched from the protected endpoint. */
async function waitForCorpus(): Promise<void> {
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/autoquote/corpus'),
      expect.anything(),
    ),
  );
}

describe('AutoQuote — 자동견적 manual-entry tab (slice 1)', () => {
  beforeEach(() => {
    __resetAutoQuoteCache();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the corpus from the JWT backend, prices a manual line with evidence, and shows a grand total', async () => {
    const user = userEvent.setup();
    renderTab();

    // corpus is fetched from the protected endpoint, not a bundled asset.
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 3000, h: 600, coats: 2 });

    const line = await screen.findByTestId('quote-line');
    // a concrete, non-zero price is shown
    expect(within(line).getByTestId('line-price')).toHaveTextContent(
      /₩\s?[1-9][\d,]*/,
    );
    // every non-discount line carries >= 1 evidence chip
    expect(within(line).getAllByTestId('evidence-chip').length).toBeGreaterThan(0);
    // a "왜 이 가격" explanation is available
    expect(within(line).getByTestId('why-expand')).toBeInTheDocument();
    // a non-zero grand total is rendered
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/₩\s?[1-9][\d,]*/);
  });

  // S3 — VAT inclusion. The grand total must be the pre-VAT subtotal plus 10% VAT.
  it('adds 10% VAT: grand-total equals the displayed 소계 subtotal × 1.1', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 3000, h: 600 });
    await screen.findByTestId('quote-line');

    const subtotal = wonNum(screen.getByText('소계').nextElementSibling);
    const grand = wonNum(screen.getByTestId('grand-total'));

    expect(subtotal).toBeGreaterThan(0);
    // grand total strictly exceeds the subtotal — a regression dropping VAT fails here.
    expect(grand).toBeGreaterThan(subtotal);
    // and it is exactly subtotal + 10% VAT.
    expect(grand).toBe(subtotal + Math.round(subtotal * 0.1));
    expect(grand / subtotal).toBeCloseTo(1.1, 5);
  });

  // S4 — low-confidence flag. A weak-support quote (off-corpus flat-median category,
  // no history match) must visibly flag itself for staff review.
  it('flags a weak-support line as low-confidence (flag + review banner + .low chip)', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    // 포맥스 is a flat-median category with no matching history row in the corpus →
    // category+size fallback → low confidence.
    await addEntry(user, { category: '포맥스', w: 500, h: 300 });

    const line = await screen.findByTestId('quote-line');
    // per-line low-confidence flag renders on the weak line
    expect(within(line).getByTestId('low-confidence-flag')).toBeInTheDocument();
    // the line carries the .low evidence chip
    const lowChip = within(line)
      .getAllByTestId('evidence-chip')
      .find((c) => c.className.includes('low'));
    expect(lowChip).toBeDefined();
    // header review banner surfaces the count for staff
    expect(screen.getByTestId('review-flag')).toBeInTheDocument();
  });

  // S8 negative — 도수 45 (bend angle) and 200 (implausible) must warn AND NOT be
  // priced as paint. Asserted RELATIVELY against the same-size no-coats baseline.
  it('treats 도수 45 and 200 as non-coats: warns and prices identically to the no-coats baseline', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 1000, h: 500 }); // baseline, no coats
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, coats: 45 });
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, coats: 200 });

    const lines = await screen.findAllByTestId('quote-line');
    expect(lines).toHaveLength(3);
    const [baseline, bend, implausible] = lines;

    // both implausible-도수 lines surface a coat-warning
    expect(within(bend).getByTestId('coat-warning')).toBeInTheDocument();
    expect(within(implausible).getByTestId('coat-warning')).toBeInTheDocument();

    // and neither is ballooned: each equals the same-size no-coats price.
    const base = linePrice(baseline);
    expect(base).toBeGreaterThan(0);
    expect(linePrice(bend)).toBe(base);
    expect(linePrice(implausible)).toBe(base);
  });

  // S8 positive — a valid N도 (3도) prices strictly higher than 1도 for the same
  // size, proving coats 1..7 are actually surcharged. Relative assertion.
  it('applies paint coats 1..7: 3도 prices strictly higher than 1도 (and both above the no-coat base)', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 1000, h: 500 }); // no coats
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, coats: 1 });
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, coats: 3 });

    const lines = await screen.findAllByTestId('quote-line');
    expect(lines).toHaveLength(3);
    const [base, one, three] = lines.map(linePrice);

    expect(one).toBeGreaterThan(base); // 1도 adds a paint surcharge
    expect(three).toBeGreaterThan(one); // more coats → strictly higher
  });

  // Refactor of the old ₩162,500 oracle into a relative assertion: 도수 90 is a bend
  // angle, so the line must equal the same-size no-balloon (no-coats) price — proving
  // intent (no paint applied) rather than pinning the size-curve constant.
  it('treats 도수 90 as a bend angle: shows a coat-warning and prices equal to the no-balloon baseline', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 1000, h: 500 }); // no-balloon baseline
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, coats: 90 });

    const lines = await screen.findAllByTestId('quote-line');
    expect(lines).toHaveLength(2);
    const [baseline, bent] = lines;

    expect(within(bent).getByTestId('coat-warning')).toBeInTheDocument();
    const base = linePrice(baseline);
    expect(base).toBeGreaterThan(0);
    // 90 is NOT priced as 90 coats — same as the no-coats baseline.
    expect(linePrice(bent)).toBe(base);
  });

  // qty effect — line price (and thus the grand total) scales proportionally to 수량.
  it('multiplies the line price proportionally to 수량', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 1000, h: 500, qty: 1 });
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, qty: 3 });

    const lines = await screen.findAllByTestId('quote-line');
    expect(lines).toHaveLength(2);
    const [single, triple] = lines.map(linePrice);

    expect(single).toBeGreaterThan(0);
    expect(triple).toBe(single * 3);

    // the grand total reflects both lines + VAT.
    const subtotal = wonNum(screen.getByText('소계').nextElementSibling);
    expect(subtotal).toBe(single + triple);
    expect(wonNum(screen.getByTestId('grand-total'))).toBe(
      subtotal + Math.round(subtotal * 0.1),
    );
  });

  // anti-scenario 6 — brandText is an IDENTITY FILTER, never a price driver. A line
  // with brandText set prices identically to the same size/category without it.
  it('uses brandText only as an identity filter: it does not change the size-driven price', async () => {
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await addEntry(user, { category: '채널간판', w: 1000, h: 500 }); // no brand
    await addEntry(user, { category: '채널간판', w: 1000, h: 500, brand: '투썸' }); // brand set

    const lines = await screen.findAllByTestId('quote-line');
    expect(lines).toHaveLength(2);
    const [plain, branded] = lines.map(linePrice);

    expect(plain).toBeGreaterThan(0);
    // brand string must NOT drive the price up (or down) — size curve governs.
    expect(branded).toBe(plain);
  });
});
