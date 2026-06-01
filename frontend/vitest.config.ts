import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config for auto-quote unit/component tests (engine pure functions + React components).
 * The Playwright acceptance specs under tests/acceptance/ are excluded — they import
 * '@playwright/test' and run via `npm run test:e2e`, not under Vitest.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: ['node_modules', 'dist', 'tests/acceptance/**'],
    passWithNoTests: true,
  },
});
