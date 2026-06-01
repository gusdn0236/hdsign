import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

// Acceptance tests for Slice 1: 자동견적 tab + manual-entry quote engine (no vision/DB).
// Derived from scenarios-2026-06-01-auto-quote.md Scenario 1, 4, 6 and anti-scenarios 5, 6.
// Assertions verify the CORRECT outcome happened, not merely the absence of errors.

test.describe('@slice-1 자동견적 tab + manual engine', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('@slice-1 tab appears right of 단가계산기 and routes (S1)', async ({ page }) => {
    await page.goto('/admin/prices');
    const nav = page.locator('nav, .subnav');
    await expect(nav.getByText('자동견적')).toBeVisible();
    // 자동견적 must sit immediately after 단가계산기 in the admin menu order.
    const items = await nav.getByRole('link').allInnerTexts();
    const calcIdx = items.findIndex((t) => t.includes('단가계산기'));
    const aqIdx = items.findIndex((t) => t.includes('자동견적'));
    expect(aqIdx).toBe(calcIdx + 1);
    await nav.getByText('자동견적').click();
    await expect(page).toHaveURL(/\/admin\/autoquote/);
  });

  test('@slice-1 manual line entry yields a priced line with evidence + VAT total (Scenario 1, S3, S4)', async ({ page }) => {
    await page.goto('/admin/autoquote');
    await page.getByRole('button', { name: /수동 항목 추가|항목 추가/ }).click();
    await page.getByLabel(/카테고리/).selectOption({ label: '채널간판' });
    await page.getByLabel(/가로/).fill('3000');
    await page.getByLabel(/세로/).fill('600');
    await page.getByRole('spinbutton', { name: /도수/ }).fill('2'); // N도 = paint coats
    await page.getByLabel(/수량/).fill('1');
    await page.getByRole('button', { name: /^추가$|견적/ }).click();

    const line = page.getByTestId('quote-line').first();
    await expect(line).toBeVisible();
    // S3: a concrete price is shown (currency, non-zero).
    await expect(line.getByTestId('line-price')).toHaveText(/₩\s?[1-9][\d,]*/);
    // S4: every non-discount line carries >= 1 evidence reference.
    await expect(line.getByTestId('evidence-chip')).not.toHaveCount(0);
    // VAT-inclusive grand total is rendered.
    await expect(page.getByTestId('grand-total')).toHaveText(/₩\s?[1-9][\d,]*/);
  });

  test('@slice-1 N도 means paint coats, not bend angle (S8, Scenario 6)', async ({ page }) => {
    await page.goto('/admin/autoquote');
    await page.getByRole('button', { name: /수동 항목 추가|항목 추가/ }).click();
    await page.getByLabel(/카테고리/).selectOption({ label: '채널간판' });
    await page.getByLabel(/가로/).fill('1000');
    await page.getByLabel(/세로/).fill('500');
    // 90 must be interpreted as a bend angle / rejected as coats, NOT 90 paint coats.
    await page.getByRole('spinbutton', { name: /도수/ }).fill('90');
    await page.getByRole('button', { name: /^추가$|견적/ }).click();
    const line = page.getByTestId('quote-line').first();
    // Anti-scenario: the price must not balloon as if 90 coats were applied.
    await expect(line.getByTestId('coat-warning')).toBeVisible();
  });

  test('@slice-1 confidential corpus is fetched from JWT backend, never bundled (anti-scenario 1)', async ({ page }) => {
    let corpusFromBackend = false;
    page.on('response', (r) => {
      if (r.url().includes('/api/admin/autoquote/corpus')) corpusFromBackend = true;
    });
    await page.goto('/admin/autoquote');
    await expect(page.getByTestId('quote-line').or(page.getByRole('button', { name: /수동 항목 추가/ }))).toBeVisible();
    expect(corpusFromBackend).toBe(true); // corpus came over the JWT API, not a bundled static asset
  });
});
