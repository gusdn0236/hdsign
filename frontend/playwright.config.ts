import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the 자동견적 (auto-quote) acceptance suite.
 * Auto-starts the Vite dev server and points the browser at it.
 * The Spring backend (/api/admin/autoquote/*) and the local easyform agent are mocked at
 * the network layer inside the specs (route interception), so only the frontend is launched here.
 */
export default defineConfig({
  testDir: './tests/acceptance',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
