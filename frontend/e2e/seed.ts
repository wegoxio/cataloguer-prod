import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * Seeds a fixture user with a known password directly into the disposable
 * database the browser suite runs against.
 *
 * WHY NOT THE INVITATION FLOW. `POST /users` invites: it creates the account
 * and emails an activation link, so the browser has no password to sign in
 * with. A browser test that needs to act AS a VIEWER cannot wait for an inbox,
 * and stubbing the mail service would prove nothing about the panel.
 *
 * The hash is produced by the backend's own `argon2` at the backend's own
 * settings, so the seeded credential is verified by the same code path a real
 * password takes — a hand-written hash would silently diverge the day those
 * settings change.
 *
 * Writes to WHATEVER DATABASE the backend under test was started with
 * (`DATABASE_URL`) — it is not created or dropped by this helper. Point it at
 * an isolated local database (the security-acceptance package used a dedicated
 * `cataloguer_secpkg_e2e`, migrated and seeded for the purpose); never at a
 * developer's working database, and never at anything remote. Rows the specs
 * create are not torn down; they are unique per run and synthetic. The
 * password is generated per run by the caller and nothing is printed.
 */
const BACKEND = path.join(__dirname, '..', '..', 'backend');

export interface SeededUser {
  email: string;
  password: string;
  role: 'SUPER_ADMIN' | 'ORGANIZATION_MANAGER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
  organizationId: string;
  /** Branch-level roles are pinned to one store; organization roles are not. */
  storeId?: string | null;
}

/**
 * Inserts (or updates) the user and returns its id.
 *
 * Runs inside the backend package so `argon2`, `pg` and `dotenv` resolve there,
 * and takes its connection string from `DATABASE_URL` — the same disposable
 * database Playwright's web server was started with.
 */
export function seedUser(user: SeededUser): string {
  const script = `
    const argon2 = require('argon2');
    const { Client } = require('pg');
    (async () => {
      const payload = JSON.parse(process.argv[1]);
      const hash = await argon2.hash(payload.password);
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const role = await client.query('select id from roles where name = $1', [payload.role]);
        if (!role.rows.length) throw new Error('role ' + payload.role + ' is not seeded');
        const inserted = await client.query(
          \`insert into users (email, password_hash, role_id, organization_id, store_id,
                              failed_login_attempts, created_at, updated_at)
            values ($1, $2, $3, $4::uuid, $5::uuid, 0, now(), now())
            on conflict (email) do update
              set password_hash = excluded.password_hash,
                  role_id = excluded.role_id,
                  organization_id = excluded.organization_id,
                  store_id = excluded.store_id,
                  failed_login_attempts = 0,
                  locked_until = null,
                  deleted_at = null,
                  updated_at = now()
            returning id\`,
          [payload.email, hash, role.rows[0].id, payload.organizationId, payload.storeId ?? null],
        );
        process.stdout.write(inserted.rows[0].id);
      } finally {
        await client.end();
      }
    })().catch((error) => { process.stderr.write(String(error && error.message)); process.exit(1); });
  `;
  return execFileSync(process.execPath, ['-e', script, JSON.stringify(user)], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: process.env,
  }).trim();
}
