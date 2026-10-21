import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * READ-ONLY-BY-DEFAULT DATABASE ACCESS FOR THE BROWSER SUITE.
 *
 * One thing a browser genuinely cannot do, and it is evidence rather than
 * convenience: read a SIBLING BRANCH'S price. The whole point of the narrowed
 * actor is that it cannot see that value, so proving the value did not move
 * has to happen somewhere the actor is not.
 *
 * There used to be a second: seeding the inventory locations an organization
 * needs before an item can be saved, because onboarding did not create them.
 * #284 closed that gap in the product — onboarding, `POST /organizations` and
 * `POST /stores` now provision custody at creation — and the fixture is gone,
 * so these suites prove the supported path suffices rather than papering over
 * it.
 *
 * The target is a DISPOSABLE database: `E2E_DATABASE_URL` when set, otherwise
 * the backend's own `DATABASE_URL`, so a normal local run works without extra
 * configuration and the suite never silently skips.
 */
const databaseUrl = (): string => {
  const explicit = process.env.E2E_DATABASE_URL;
  if (explicit) return explicit;
  const envFile = path.resolve(__dirname, '../../backend/.env');
  const match = readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(.+)$/m);
  if (!match) throw new Error('no E2E_DATABASE_URL and no DATABASE_URL in backend/.env');
  return match[1].trim().replace(/^["']|["']$/g, '');
};

/** Rows of a SELECT, as JSON. */
export function query<T = Record<string, unknown>>(statement: string): T[] {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) from (${statement}) t`;
  const out = execFileSync('psql', [databaseUrl(), '-X', '-tA', '-c', wrapped], { encoding: 'utf8' });
  return JSON.parse(out.trim() || '[]');
}

/** A statement run for its effect. Test fixtures only. */
export function execute(statement: string): void {
  execFileSync('psql', [databaseUrl(), '-X', '-q', '-c', statement], { encoding: 'utf8' });
}

/** Every membership and price pivot for these products, ordered — the snapshot. */
export function pivots(productIds: string[]): unknown[] {
  const list = productIds.map((id) => `'${id}'::uuid`).join(',');
  return query(`
    select product_id, store_id, published, price, sale_price, track_inventory
      from store_products
     where product_id in (${list})
     order by product_id, store_id
  `);
}
