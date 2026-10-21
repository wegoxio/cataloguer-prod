import { defineConfig } from '@playwright/test';

/**
 * PR A's rendered acceptance. Its own config for the same reason as the mapping
 * suite: every API call is answered in the browser, so the only server is Next
 * itself — no database, no runner, and no production data.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/pra-parent-child-layout.spec.ts'],
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm run dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 180_000 },
});
