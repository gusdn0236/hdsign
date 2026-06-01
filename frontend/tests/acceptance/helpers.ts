import type { Page } from '@playwright/test';

// Seeds an admin JWT session for hdsign admin. The scaffold job adapts this to hdsign's
// AuthContext (token in localStorage) using a test admin credential from the harness env.
// Keep it real: a broken login must make dependent tests fail, not silently pass.
export async function loginAsAdmin(page: Page): Promise<void> {
  const token = process.env.AQ_TEST_ADMIN_JWT;
  if (token) {
    await page.addInitScript((t) => {
      window.localStorage.setItem('token', t as string);
    }, token);
    return;
  }
  // Fallback: drive the real login form.
  await page.goto('/login');
  await page.getByLabel(/아이디|이메일|email/i).fill(process.env.AQ_TEST_ADMIN_ID ?? 'admin');
  await page.getByLabel(/비밀번호|password/i).fill(process.env.AQ_TEST_ADMIN_PW ?? 'admin');
  await page.getByRole('button', { name: /로그인|sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

// Realistic mocked vision response (rich schema) for @slice-2+ tests — route-intercepted so
// CI never calls Claude. Mirrors the forced-tool-use output shape declared in the spec.
export const MOCK_VISION_ITEMS = {
  client: '㈜대한사인',
  contact: '김현우',
  order_date: '2026-06-01',
  due_date: '2026-06-08',
  sign_types: ['채널간판', '돌출간판', '시트컷팅'],
  materials: ['아크릴', '시트'],
  dimensions: [
    { w: 3000, h: 600, coats: 2 },
    { w: 1200, h: 400 },
    { w: 1100, h: 300 },
  ],
  brand_text: '투썸',
  qty: [1, 1, 2],
  notes: 'LED 포함',
};
