import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { storeLocationCode } from '../src/modules/inventory/ledger/inventory.types';

/**
 * Minimal seed helpers for the P5-B1 real-PostgreSQL suites.
 *
 * Raw SQL on purpose: these tests are about what the DATABASE enforces, so the
 * fixtures must not travel through the ORM's own validation and hide a missing
 * constraint. Lives under `test/` rather than `src/` so the inventory writer
 * gates, which walk `src`, never see it as production code.
 */

export interface SeededOrg {
  organizationId: string;
  storeId: string;
  warehouseId: string;
  storeLocationId: string;
  productId: string;
}

const uniq = (): string => randomUUID().slice(0, 8);

export async function seedOrganization(em: EntityManager, label = 'org'): Promise<SeededOrg> {
  const suffix = uniq();
  const [org]: { id: string }[] = await em.execute(
    `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
    [`${label}-${suffix}`, `${label}-${suffix}`],
  );
  const [store]: { id: string }[] = await em.execute(
    `insert into stores (name, slug, organization_id, created_at, updated_at)
     values (?, ?, ?::uuid, now(), now()) returning id`,
    [`store-${suffix}`, `store-${suffix}`, org.id],
  );
  const [product]: { id: string }[] = await em.execute(
    `insert into products (name, slug, organization_id, created_at, updated_at)
     values (?, ?, ?::uuid, now(), now()) returning id`,
    [`product-${suffix}`, `product-${suffix}`, org.id],
  );
  const warehouseId = await createLocation(em, org.id, 'WAREHOUSE', `WH-${suffix}`, 'Main warehouse', null, true);
  const storeLocationId = await createLocation(
    em,
    org.id,
    'STORE',
    storeLocationCode(store.id),
    `store-${suffix} custody`,
    store.id,
    false,
  );
  return {
    organizationId: org.id,
    storeId: store.id,
    warehouseId,
    storeLocationId,
    productId: product.id,
  };
}

/**
 * P5-X1 — runs `fn` with the organization frozen for cutover.
 *
 * An OPENING_BALANCE may only post inside a declared cutover window, so every
 * fixture that seeds stock through an opening now has to open one. The freeze
 * is released in a `finally` so a failing expectation still leaves the
 * organization able to accept ordinary postings — otherwise one broken test
 * would cascade into every later test that shares the fixture.
 */
export async function withCutoverFreeze<T>(
  em: EntityManager,
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await em.execute('update organizations set inventory_cutover_frozen_at = now() where id = ?', [organizationId]);
  try {
    return await fn();
  } finally {
    await em.execute('update organizations set inventory_cutover_frozen_at = null where id = ?', [organizationId]);
  }
}

export async function createProduct(em: EntityManager, organizationId: string, parentId?: string): Promise<string> {
  const suffix = uniq();
  const [row]: { id: string }[] = await em.execute(
    `insert into products (name, slug, organization_id, parent_id, created_at, updated_at)
     values (?, ?, ?::uuid, ?::uuid, now(), now()) returning id`,
    [`product-${suffix}`, `product-${suffix}`, organizationId, parentId ?? null],
  );
  return row.id;
}

export async function createLocation(
  em: EntityManager,
  organizationId: string,
  kind: 'WAREHOUSE' | 'STORE',
  code: string,
  name: string,
  storeId: string | null,
  isDefault: boolean,
): Promise<string> {
  const [row]: { id: string }[] = await em.execute(
    `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
     values (?::uuid, ?, ?, ?, ?::uuid, ?, now(), now()) returning id`,
    [organizationId, kind, code, name, storeId, isDefault],
  );
  return row.id;
}

/**
 * Names the non-internal triggers and public functions a given boundary owns.
 *
 * Boundary specs assert their OWN objects by name rather than a global count:
 * a later migration adding its own trigger must not break an earlier
 * boundary's proof, and a global total says nothing about which objects exist.
 */
export async function triggerAndFunctionNames(
  em: EntityManager,
  prefix: string,
): Promise<{ triggers: string[]; functions: string[] }> {
  const triggers: { tgname: string }[] = await em.execute(
    `select t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where not t.tgisinternal and t.tgname like ? order by 1`,
    [`${prefix}%`],
  );
  const functions: { proname: string }[] = await em.execute(
    `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where p.proname like ? order by 1`,
    [`${prefix}%`],
  );
  return { triggers: triggers.map((r) => r.tgname), functions: functions.map((r) => r.proname) };
}

/** Counts non-internal triggers and public functions — the F5 baseline pair. */
export async function triggerAndFunctionCounts(em: EntityManager): Promise<{ triggers: number; functions: number }> {
  const [t]: { n: number }[] = await em.execute(
    `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where not t.tgisinternal`,
  );
  const [f]: { n: number }[] = await em.execute(
    `select count(*)::int as n from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'`,
  );
  return { triggers: t.n, functions: f.n };
}
