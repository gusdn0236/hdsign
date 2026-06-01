import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../../../context/AuthContext.jsx';
import AutoQuote from '../AutoQuote';
import { __resetAutoQuoteCache } from '../data/corpusClient';
import { visionToLineInputs } from './visionMapping';
import type { VisionItems } from './visionClient';

/**
 * Slice 2 behavioral tests — paste/upload 작업지시서 → backend vision proxy → priced
 * overlay, with manual-entry fallback. Vision is fetch-mocked (no live Claude, no key
 * in the browser). Assertions check OBSERVABLE outcomes: pins rendered on the image,
 * prices computed through the real engine, a non-zero VAT-inclusive grand total, a
 * fallback banner on a vision error while manual entry still prices — and that NO
 * Anthropic endpoint/key is ever read or sent from the client.
 */

// Realistic corpus (same shape as the JWT /corpus endpoint serves).
const CORPUS = {
  _meta: { lineCount: 1 },
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
  ],
};
const PRIORS = { sizeBuckets: {} };

// Rich-schema vision result (mirrors helpers.ts MOCK_VISION_ITEMS — 3 detected items).
const MOCK_VISION_ITEMS: VisionItems = {
  client: '㈜대한사인',
  contact: '김현우',
  order_date: '2026-06-01',
  due_date: '2026-06-08',
  sign_types: ['채널간판', '돌출간판', '시트컷팅'],
  materials: ['아크릴', '시트'],
  dimensions: [{ w: 3000, h: 600, coats: 2 }, { w: 1200, h: 400 }, { w: 1100, h: 300 }],
  brand_text: '투썸',
  qty: [1, 1, 2],
  notes: 'LED 포함',
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[];

/** fetch mock: serves corpus/priors and a configurable /vision responder. */
function installFetch(visionResponder: () => Response): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/vision')) return visionResponder();
      const body = url.includes('/priors') ? PRIORS : CORPUS;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const okVision = (): Response =>
  new Response(JSON.stringify(MOCK_VISION_ITEMS), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const failVision = (): Response =>
  new Response('{"error":"vision_timeout"}', { status: 504 });

function renderTab() {
  return render(
    <AuthProvider>
      <AutoQuote />
    </AuthProvider>,
  );
}

async function waitForCorpus(): Promise<void> {
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/autoquote/corpus'),
      expect.anything(),
    ),
  );
}

const wonNum = (el: Element | null): number =>
  parseInt((el?.textContent ?? '').replace(/[^\d]/g, ''), 10);

/** A tiny in-memory PNG file for the upload input. */
const samplePng = (): File =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'work-order.png', {
    type: 'image/png',
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visionToLineInputs (rich-schema → LineInput mapping)', () => {
  it('maps each sign_type to a LineInput with its dimensions, qty (default 1), and shared brand_text', () => {
    const lines = visionToLineInputs(MOCK_VISION_ITEMS);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      category: '채널간판',
      w: 3000,
      h: 600,
      coats: 2,
      qty: 1,
      brandText: '투썸',
    });
    // line 2 has no qty entry override but mock provides qty[2]=2
    expect(lines[2]).toMatchObject({ category: '시트컷팅', w: 1100, h: 300, qty: 2 });
    // brand_text is shared across all lines (identity filter, not per-line)
    expect(lines.every((l) => l.brandText === '투썸')).toBe(true);
  });

  it('defaults qty to 1 when the vision result omits it', () => {
    const lines = visionToLineInputs({ sign_types: ['포맥스'], dimensions: [{ w: 500, h: 300 }] });
    expect(lines[0].qty).toBe(1);
  });
});

describe('AutoQuote — slice 2 vision overlay', () => {
  beforeEach(() => {
    __resetAutoQuoteCache();
  });

  it('uploads a work order, prices each detected item via the engine, and overlays priced pins on the image', async () => {
    installFetch(okVision);
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await user.upload(screen.getByTestId('work-order-upload'), samplePng());

    // Three detected items → three priced overlay pins on the image.
    const pins = await screen.findAllByTestId('price-overlay');
    expect(pins).toHaveLength(3);
    // the displayed work-order image is rendered (not dropped)
    expect(screen.getByTestId('work-order-image')).toBeInTheDocument();
    // the first detected line (채널간판) is auto-priced to a concrete non-zero amount
    expect(pins[0]).toHaveTextContent(/₩\s?[1-9][\d,]*/);
    // success status surfaces the detected count
    expect(screen.getByTestId('vision-status')).toHaveTextContent(/3개 항목 검출/);
    // the same lines feed the existing priced list + VAT-inclusive grand total
    expect(screen.getAllByTestId('quote-line')).toHaveLength(3);
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/₩\s?[1-9][\d,]*/);
  });

  it('the vision POST sends image base64 + mediaType to the JWT backend proxy only', async () => {
    installFetch(okVision);
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();
    await user.upload(screen.getByTestId('work-order-upload'), samplePng());
    await screen.findAllByTestId('price-overlay');

    const visionCall = calls.find((c) => c.url.includes('/api/admin/autoquote/vision'));
    expect(visionCall).toBeDefined();
    expect(visionCall!.init?.method).toBe('POST');
    const body = JSON.parse(String(visionCall!.init?.body));
    expect(typeof body.imageBase64).toBe('string');
    expect(body.imageBase64.length).toBeGreaterThan(0);
    expect(body.mediaType).toBe('image/png');
  });

  it('falls back to a banner on a vision error and keeps manual entry fully usable (engine still prices)', async () => {
    installFetch(failVision);
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();

    await user.upload(screen.getByTestId('work-order-upload'), samplePng());

    // non-blocking fallback banner appears, no overlay pins
    expect(await screen.findByTestId('vision-fallback-banner')).toBeVisible();
    expect(screen.queryAllByTestId('price-overlay')).toHaveLength(0);
    // the manual "추가" affordance is still enabled
    expect(screen.getByRole('button', { name: '추가' })).toBeEnabled();

    // and a manually entered line still gets priced by the engine
    await user.selectOptions(screen.getByLabelText(/카테고리/), '채널간판');
    await user.clear(screen.getByLabelText(/가로/));
    await user.type(screen.getByLabelText(/가로/), '3000');
    await user.clear(screen.getByLabelText(/세로/));
    await user.type(screen.getByLabelText(/세로/), '600');
    await user.click(screen.getByRole('button', { name: '추가' }));

    const line = await screen.findByTestId('quote-line');
    expect(within(line).getByTestId('line-price')).toHaveTextContent(/₩\s?[1-9][\d,]*/);
    expect(wonNum(screen.getByTestId('grand-total'))).toBeGreaterThan(0);
    // exactly one retry-free vision call was made (no auto-retry storm)
    expect(calls.filter((c) => c.url.includes('/vision'))).toHaveLength(1);
  });

  it('never reads or sends an Anthropic key/endpoint from the client', async () => {
    installFetch(okVision);
    const user = userEvent.setup();
    renderTab();
    await waitForCorpus();
    await user.upload(screen.getByTestId('work-order-upload'), samplePng());
    await screen.findAllByTestId('price-overlay');

    for (const c of calls) {
      // no direct Anthropic endpoint from the browser
      expect(c.url).not.toMatch(/anthropic/i);
      const headers = JSON.stringify(c.init?.headers ?? {});
      const body = String(c.init?.body ?? '');
      // no API key material ever leaves the client
      expect(headers).not.toMatch(/x-api-key/i);
      expect(headers).not.toMatch(/sk-ant/i);
      expect(headers).not.toMatch(/anthropic/i);
      expect(body).not.toMatch(/sk-ant/i);
      expect(body).not.toMatch(/x-api-key/i);
    }
  });
});
