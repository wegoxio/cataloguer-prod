import { defineConfig } from '@playwright/test';

/**
 * The mapping-stage geometry suite.
 *
 * Its own config because it needs NO backend: every API call is answered in the
 * browser, so the only server is Next itself. That matters for what this suite
 * is for — it has to be runnable against an arbitrary frontend tree (the
 * rollback production source, a rejected release) without also standing up the
 * database and runner that tree happens to expect.
 */
export default defineConfig({
  testDir: './e2e',
  // Every suite listed here answers its own API calls in the browser and needs
  // only Next: the mapping-stage geometry suite, the parent/child layout
  // suite that proves the Items table at desktop and 390px, the Items
  // pagination suite that walks twenty stubbed pages at three widths, and the
  // selection-scope suite that proves which selections survive a page change.
  testMatch: [
    '**/wizard-mapping-layout.spec.ts',
    '**/pra-parent-child-layout.spec.ts',
    '**/prb-join-existing-group-layout.spec.ts',
    '**/items-pagination-layout.spec.ts',
    '**/items-selection-layout.spec.ts',
    // The assets-collections suite: tree, breadcrumb and dialogs at desktop and
    // 390px, by keyboard, on stubbed data (ADR 030, phase 2).
    '**/assets-collections-layout.spec.ts',
  ],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
