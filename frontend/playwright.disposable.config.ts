import { defineConfig } from '@playwright/test';

/**
 * THE BROWSER SUITE ON A STACK THIS RUN OWNS, END TO END.
 *
 * The ordinary `playwright.config.ts` has `reuseExistingServer: true`, which is
 * right for a developer with their app already up and WRONG for evidence: a
 * green run would then say nothing about which database, which build or which
 * backend was actually exercised — and the shared local database is off limits
 * for this work entirely.
 *
 * So this config:
 *
 *   · refuses to reuse anything (`reuseExistingServer: false`), on ports the
 *     ordinary pair does not use, so a running dev stack cannot be mistaken for
 *     this one and this one cannot collide with it;
 *   · starts the backend with `DATABASE_URL` pointed at the disposable database
 *     the runner created, migrated and seeded;
 *   · starts the frontend with `NEXT_PUBLIC_API_URL` pointed at THAT backend;
 *   · passes the same database to the suite's own psql helper through
 *     `E2E_DATABASE_URL`, so its assertions read the database under test.
 *
 * `E2E_DATABASE_URL` is REQUIRED. Defaulting it would put the shared database
 * one forgotten variable away from being the target, which is the failure this
 * whole arrangement exists to make impossible.
 */
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('E2E_DATABASE_URL is required: this config never falls back to the shared database');
}

const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 3101);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT || 3100);
const apiUrl = `http://localhost:${BACKEND_PORT}/api/v1`;

/**
 * OBJECT STORAGE THAT THIS RUN OWNS (assets library journey).
 *
 * `backend/.env` points at the real storage bucket. A browser journey that
 * uploads must never write there, so when `E2E_FAKE_STORAGE_PORT` is set every
 * storage variable is REPLACED — endpoint, bucket, public URL and credentials —
 * with a local in-memory server the suite itself starts. Exported variables
 * win over dotenv, so nothing from `.env` survives for these keys. The suite
 * that uploads refuses to run without it.
 */
const fakeStoragePort = process.env.E2E_FAKE_STORAGE_PORT;
const storageEnv: Record<string, string> = fakeStoragePort
  ? {
      STORAGE_ENDPOINT: `http://localhost:${fakeStoragePort}`,
      STORAGE_REGION: 'auto',
      STORAGE_BUCKET: 'e2e-fake-bucket',
      // An IP, not `localhost`: product photos validate their URL with
      // `@IsUrl()`, which refuses a host without a TLD but accepts an address.
      STORAGE_PUBLIC_URL: `http://127.0.0.1:${fakeStoragePort}/public`,
      STORAGE_ACCESS_KEY_ID: 'e2e-fake-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'e2e-fake-secret-key',
    }
  : {};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --dir ../backend run start',
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: databaseUrl,
        PORT: String(BACKEND_PORT),
        NODE_ENV: 'development',
        CORS_ALLOWED_ORIGINS: `http://localhost:${FRONTEND_PORT}`,
        ...storageEnv,
      },
    },
    {
      /**
       * `next dev` DIRECTLY, with the port as an argument.
       *
       * `pnpm run dev` is `next dev -p 3000` — the port is baked into the
       * script, so a `PORT` variable is ignored and the server comes up on the
       * developer's own port. Playwright then waits for a frontend that will
       * never appear, and the one that did appear is sitting on the port a
       * developer's stack uses. The argument is the only thing `next` listens
       * to, so the argument is what this passes.
       */
      command: `pnpm exec next dev -p ${FRONTEND_PORT}`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NEXT_PUBLIC_API_URL: apiUrl,
      },
    },
  ],
});
