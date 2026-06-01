import { test, expect } from '@playwright/test';
import { loginAsAdmin, MOCK_VISION_ITEMS } from './helpers';

// Slice 3: correct a price + reason → persisted to MySQL → top prior for ALL staff.
// Derived from Scenario 3, S5, and anti-scenario 6 (brand not a price predictor).

test.describe('@slice-3 shared corrections', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/autoquote/vision', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_VISION_ITEMS) }),
    );
  });

  test('@slice-3 correction persists and resurfaces as top prior on next quote (Scenario 3, S5)', async ({ page, request }) => {
    await page.goto('/admin/autoquote');
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');

    const line = page.getByTestId('quote-line').filter({ hasText: '돌출간판' });
    await line.getByRole('button', { name: /가격 수정|이유 적기/ }).click();
    await line.getByTestId('correction-price').fill('95000');
    await line.getByTestId('correction-reason').fill('야간 시공 할증 포함');
    await line.getByRole('button', { name: /공유 저장/ }).click();
    await expect(page.getByTestId('correction-saved-toast')).toBeVisible();

    // Server-side: the correction is the top prior on a fresh fetch (shared across staff).
    const res = await request.get('/api/admin/autoquote/corrections');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const top = body.find((c: any) => String(c.featureKey).includes('돌출간판'));
    expect(top).toBeTruthy();
    expect(Number(top.correctedUnitPrice)).toBe(95000);
    expect(top.explanation).toContain('야간');

    // Re-quoting the same item surfaces the corrected price + a 보정prior evidence chip.
    await page.reload();
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');
    const reLine = page.getByTestId('quote-line').filter({ hasText: '돌출간판' });
    await expect(reLine.getByTestId('line-price')).toHaveText(/95,000/);
    await expect(reLine.getByTestId('evidence-chip').filter({ hasText: /보정|prior/ })).toBeVisible();
  });
});
