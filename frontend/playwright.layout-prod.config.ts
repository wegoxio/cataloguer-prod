import { defineConfig } from '@playwright/test';

/**
 * The same geometry suite, aimed at a DEPLOYED build.
 *
 * A regression test that only runs against the working tree cannot answer the
 * question that matters after a rejected release — "was this already broken in
 * what production is serving?" — so the suite is written to discover the page's
 * scroll owner rather than to be told, and this config points it at a host.
 *
 *   LAYOUT_BASE_URL=https://catalog.wegox.io pnpm run test:layout:deployed
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/wizard-mapping-layout.spec.ts'],
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.LAYOUT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
});
