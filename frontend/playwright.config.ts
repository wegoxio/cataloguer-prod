import { defineConfig } from '@playwright/test';

/**
 * Critical-flow E2E tests (manual §10). Run locally with `pnpm run test:e2e`.
 * Requires local PostgreSQL (migrated + seeded backend/.env dev admin).
 * Both servers are started automatically if not already running.
 * Local-only: there is no CI runner (GitHub Actions was removed), so this suite
 * is run by hand before a release.
 *
 * The default run must report ZERO SKIPPED TESTS: a skipped test in an
 * acceptance suite is a claim nobody checked. Anything that only holds in a
 * different configuration goes in `e2e/optional/` and is run explicitly in that
 * configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /*
   * `e2e/optional/` holds suites that describe a NON-canonical configuration —
   * today, the website builder with `NEXT_PUBLIC_WEBSITE_BUILDER_STATUS=
   * AVAILABLE`.
   *
   * They are EXCLUDED rather than skipped, so the default run reports zero
   * skipped tests, and the exclusion is decided by the very variable that
   * decides the build: set it to `AVAILABLE` and the suite is both included
   * here and reachable in the browser; leave it alone and it is neither.
   * Tying the two to one literal is what stops the pair drifting into "the
   * tests ran against a build that gated the thing they test".
   *
   *   NEXT_PUBLIC_WEBSITE_BUILDER_STATUS=AVAILABLE npx playwright test e2e/optional
   */
  testIgnore: process.env.NEXT_PUBLIC_WEBSITE_BUILDER_STATUS === 'AVAILABLE' ? [] : ['**/optional/**'],
  timeout: 30_000,
  fullyParallel: false, // login is rate-limited to 5/min; keep attempts sequential
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --dir ../backend run start:dev',
      url: 'http://localhost:3001/api/v1/health',
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: 'pnpm run dev',
      url: 'http://localhost:3000',
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
