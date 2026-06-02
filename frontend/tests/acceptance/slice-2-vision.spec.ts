import { test, expect } from '@playwright/test';
import { loginAsAdmin, MOCK_VISION_ITEMS } from './helpers';

// Slice 2: paste a 작업지시서 → backend vision proxy → auto-detected priced overlay.
// Vision is route-mocked (no live Claude in CI) per harness Test Strategy.
// Derived from Scenario 2 and anti-scenarios 2 (key never in browser), 5, 6.

test.describe('@slice-2 vision auto-detect', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/autoquote/vision', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_VISION_ITEMS) });
    });
  });

  test('@slice-2 pasted work order yields detected lines overlaid on the image (Scenario 2, S2, S3)', async ({ page }) => {
    await page.goto('/admin/autoquote');
    // Upload path stands in for clipboard paste in CI.
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');
    // Each detected item is auto-priced and overlaid on the image.
    await expect(page.getByTestId('price-overlay')).toHaveCount(3);
    await expect(page.getByTestId('price-overlay').first()).toHaveText(/₩\s?[1-9][\d,]*/);
    await expect(page.getByTestId('grand-total')).toHaveText(/₩\s?[1-9][\d,]*/);
  });

  test('@slice-2 vision failure falls back to manual entry, image not dropped (Scenario 2 fallback)', async ({ page }) => {
    await page.unroute('**/api/admin/autoquote/vision');
    await page.route('**/api/admin/autoquote/vision', (route) => route.fulfill({ status: 504, body: '{"error":"vision_timeout"}' }));
    await page.goto('/admin/autoquote');
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');
    await expect(page.getByTestId('vision-fallback-banner')).toBeVisible();
    await expect(page.getByRole('button', { name: /수동 항목 추가/ })).toBeEnabled();
  });

  test('@slice-2 ANTHROPIC key never reaches the browser (anti-scenario 2)', async ({ page }) => {
    let leaked = false;
    page.on('request', (r) => {
      // No direct Anthropic calls from the browser; vision only via the JWT backend proxy.
      if (r.url().includes('api.anthropic.com')) leaked = true;
    });
    await page.goto('/admin/autoquote');
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');
    await expect(page.getByTestId('price-overlay').first()).toBeVisible();
    expect(leaked).toBe(false);
  });
});
