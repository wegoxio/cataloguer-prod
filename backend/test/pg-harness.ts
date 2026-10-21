import { MikroORM } from '@mikro-orm/postgresql';
import { randomBytes } from 'crypto';
import { isIP } from 'net';
import config from '../src/database/mikro-orm.config';

// `pg` ships no bundled types and @types/pg is not a dependency; it's only used
// here for CREATE/DROP DATABASE against the loopback maintenance connection.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

const DB_NAME_RE = /^cataloguer_test_[a-z0-9_]+$/;

/**
 * True only for a real loopback target.
 *
 * Classified by IP, never by string prefix: a name like `127.example.com`
 * starts with "127." yet resolves wherever its owner points it, so a
 * prefix test would let a remote database masquerade as local. Only
 * `localhost`, `::1`, and an actual address in 127.0.0.0/8 qualify.
 */
export const isLoopback = (host: string): boolean => {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const ipv4 = isIP(h) === 4 ? h.split('.').map(Number) : null;
  return ipv4 !== null && ipv4[0] === 127;
};

/**
 * Whether the real-Postgres suite may run. Requires BOTH an explicit opt-in
 * and a loopback TEST_DATABASE_URL, so it never touches staging/production and
 * never runs by accident during ordinary `pnpm test`.
 */
export function pgTestsEnabled(): { enabled: boolean; reason: string } {
  if (process.env.ALLOW_PG_DISPOSABLE_TESTS !== '1') return { enabled: false, reason: 'ALLOW_PG_DISPOSABLE_TESTS!=1' };
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { enabled: false, reason: 'TEST_DATABASE_URL unset' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { enabled: false, reason: 'TEST_DATABASE_URL unparseable' };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { enabled: false, reason: 'TEST_DATABASE_URL not a postgres url' };
  if (!isLoopback(u.hostname)) return { enabled: false, reason: 'TEST_DATABASE_URL host is not loopback' };
  return { enabled: true, reason: 'ok' };
}

export interface DisposablePg {
  orm: MikroORM;
  dbName: string;
  close: () => Promise<void>;
}

/**
 * Boots a throwaway Postgres database for a real-DB test and returns an
 * initialised MikroORM plus a `close()` that drops ONLY the database it created.
 *
 * Safety contract:
 *  - runs only against a loopback TEST_DATABASE_URL, with an explicit opt-in;
 *  - TEST_DATABASE_URL is used purely as a maintenance connection — its own
 *    database is never migrated, truncated or dropped;
 *  - the disposable database name is generated from a validated prefix and
 *    re-asserted before every CREATE/DROP;
 *  - `close()` terminates this harness's connections and drops only the
 *    database it created (in a finally, even if init/migrate failed).
 *
 * `opts.migrateTo` migrates only through the named migration (used to stage a
 * pre-#182 schema); omitted, it migrates to latest.
 *
 * `opts.entities` registers ADDITIONAL entity classes alongside the application
 * ones. #290 needs it: proving that the default removal filter excludes removed
 * rows from ordinary reads requires a real mapped entity carrying the filter,
 * and inventing a production-removable entity to test the mechanism would be
 * exactly the wrong way round. The extra classes exist only for the suite that
 * passes them, and their tables are created by that suite.
 */
export async function withDisposablePg(opts: { migrateTo?: string; entities?: unknown[] } = {}): Promise<DisposablePg> {
  const gate = pgTestsEnabled();
  if (!gate.enabled) throw new Error(`disposable pg disabled: ${gate.reason}`);

  const maintUrl = new URL(process.env.TEST_DATABASE_URL as string);
  if (!isLoopback(maintUrl.hostname)) throw new Error('refusing non-loopback host');
  const maintDbName = maintUrl.pathname.replace(/^\//, '') || 'postgres';

  const dbName = `cataloguer_test_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`.toLowerCase();
  if (!DB_NAME_RE.test(dbName)) throw new Error('generated db name failed validation');
  if (dbName === maintDbName) throw new Error('generated db name collides with maintenance db');

  const admin = new Client({ connectionString: maintUrl.toString(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  const appUrl = new URL(maintUrl.toString());
  appUrl.pathname = `/${dbName}`;

  let orm: MikroORM;
  try {
    const base = config as any;
    orm = await MikroORM.init({
      ...base,
      clientUrl: appUrl.toString(),
      entities: opts.entities?.length ? [...(base.entities ?? []), ...opts.entities] : base.entities,
    });
    const migrator = orm.getMigrator();
    await (opts.migrateTo ? migrator.up({ to: opts.migrateTo }) : migrator.up());
  } catch (err) {
    await dropDisposable(maintUrl, dbName, maintDbName);
    throw err;
  }

  const close = async () => {
    try {
      await orm.close(true);
    } catch {
      /* ignore close errors — we still drop below */
    }
    await dropDisposable(maintUrl, dbName, maintDbName);
  };

  return { orm, dbName, close };
}

async function dropDisposable(maintUrl: URL, dbName: string, maintDbName: string): Promise<void> {
  if (!DB_NAME_RE.test(dbName) || dbName === maintDbName) {
    throw new Error(`refusing to drop unexpected database "${dbName}"`);
  }
  const admin = new Client({ connectionString: maintUrl.toString(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [dbName],
    );
    await admin.query(`drop database if exists "${dbName}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Inserts an organization with RAW SQL, for suites booted at an EARLIER
 * migration than the entity describes.
 *
 * `Organization` grows columns over time — `default_content_locale` arrived
 * with P5-W2 — and MikroORM emits every declared column on insert. A suite
 * that deliberately stops at an older revision therefore cannot use the ORM to
 * seed one: the insert fails on a column the migration under test has not
 * created yet, for a reason that has nothing to do with what the suite is
 * proving. Naming the columns explicitly here keeps those suites pinned to the
 * schema they are actually testing.
 *
 * Only the columns that have existed since the organizations table was created
 * are named, so this stays valid at every revision a suite might stop at.
 */
export async function insertOrganizationRaw(
  em: { execute: (sql: string, params?: unknown[]) => Promise<any> },
  organization: { name: string; slug: string },
): Promise<string> {
  const rows = await em.execute(
    `insert into organizations (name, slug, created_at, updated_at)
     values (?, ?, now(), now()) returning id`,
    [organization.name, organization.slug],
  );
  return rows[0].id as string;
}
