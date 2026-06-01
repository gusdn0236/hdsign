import { test, expect } from '@playwright/test';
import { loginAsAdmin, MOCK_VISION_ITEMS } from './helpers';

// Slice 4: optional local easyform auto-fill, feature-detected against the 127.0.0.1 agent.
// Derived from Scenario 5, S6, and anti-scenario 7 (never auto-commit / no Enter/Save).

test.describe('@slice-4 optional easyform fill', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/autoquote/vision', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_VISION_ITEMS) }),
    );
  });

  test('@slice-4 button hidden when local agent absent (feature-detect, S6)', async ({ page }) => {
    await page.route('**127.0.0.1:17345/**', (route) => route.abort());
    await page.goto('/admin/autoquote');
    await expect(page.getByRole('button', { name: /easyform 자동기입/ })).toHaveCount(0);
  });

  test('@slice-4 fill maps lines to cells and NEVER sends Enter/Save (anti-scenario 7)', async ({ page }) => {
    const sentKeys: string[] = [];
    await page.route('**127.0.0.1:17345/easyform/**', async (route) => {
      const req = route.request();
      if (req.url().includes('/probe')) {
        return route.fulfill({ status: 200, body: '{"present":true}' });
      }
      const payload = req.postDataJSON?.() ?? {};
      (payload.keys ?? []).forEach((k: string) => sentKeys.push(k));
      return route.fulfill({ status: 200, body: '{"filled":true}' });
    });
    await page.goto('/admin/autoquote');
    await page.getByTestId('work-order-upload').setInputFiles('tests/acceptance/fixtures/work-order-sample.png');
    await page.getByRole('button', { name: /easyform 자동기입/ }).click();
    await page.getByRole('button', { name: /셀 채우기/ }).click();
    await expect(page.getByTestId('easyform-fill-done')).toBeVisible();
    // Iron Law: cell input only — no VK_RETURN / save-confirm keystrokes.
    expect(sentKeys).not.toContain('VK_RETURN');
    expect(sentKeys.join(',').toUpperCase()).not.toMatch(/ENTER|RETURN|SAVE/);
  });
});
