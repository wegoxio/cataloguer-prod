import { EntityManager } from '@mikro-orm/postgresql';
import { storeLocationCode } from '../ledger/inventory.types';
import { defaultWarehouseCode } from '../opening/inventory-opening.types';

/**
 * THE CUSTODY IDENTITIES A COMPANY CANNOT WORK WITHOUT, PROVISIONED INSIDE THE
 * CALLER'S TRANSACTION (#284).
 *
 * Every stock movement resolves a location first: a product-level quantity
 * lands in the organization's one default WAREHOUSE, a branch-level quantity in
 * that branch's one STORE custody location. Until Slice B/C shipped, the only
 * writer of a default warehouse was `InventoryOpeningService.bootstrapLocations`,
 * whose sole caller is the operator CLI. So every organization onboarded
 * through the product had no warehouse, and the first thing an operator did
 * after onboarding a client — open an item and save it — was refused with
 * "This organization has no default warehouse".
 *
 * These functions ARE the domain rules, stated once and shared by every writer
 * that creates the thing needing custody: the code derivations, the names, the
 * "exactly one default per organization", the "one location per store". The
 * opening service's bootstrap delegates here rather than the other way round,
 * so a company created after the Phase 5 cutover and a company bootstrapped
 * during it receive byte-identical rows.
 *
 * TRANSACTION-AWARE, NOT TRANSACTIONAL. Each function takes the caller's
 * EntityManager and opens nothing of its own. That is the whole point: the
 * organization, its store, its manager, its invitation and its custody
 * identities commit together or not at all, and an idempotent retry that finds
 * the organization already committed finds the locations with it.
 *
 * CONCURRENCY. Each function is select-then-insert, so two writers racing on
 * the same organization would both read "absent". Every supported caller holds
 * `OrganizationPlanPolicy.lock(organizationId)` before calling, which serialises
 * them; and the two partial unique indexes —
 * `inventory_locations_one_default_per_org` and
 * `inventory_locations_one_per_store` — make a duplicate impossible rather than
 * merely unlikely for any caller that does not. The loser of such a race gets
 * a unique violation and its transaction rolls back: fail closed, never two
 * warehouses. `inventory-location-provisioning.pg.spec.ts` races two unlocked
 * transactions to prove exactly that.
 *
 * OPENING-EPOCH SEMANTICS, settled here because #284 asked. A newly created
 * organization has `inventory_cutover_frozen_at = null`, and
 * `InventoryPostingService.assertCutoverFreeze` is symmetrical: an unfrozen
 * organization may post ORDINARY movements and may NOT post an
 * `OPENING_BALANCE`. The epoch exists only to convert pre-ledger legacy
 * quantities, and a company created after the cutover has none. Its ledger
 * starts empty; its first ordinary posting is its opening. Provisioning
 * custody identities therefore neither requires nor permits an epoch — which is
 * the same rule the freeze already enforces, not a new one.
 */
export interface ProvisionedLocation {
  id: string;
  /** Whether THIS call inserted the row — false when it already existed. */
  created: boolean;
}

/** Exactly one default WAREHOUSE per organization; product-level stock lands here. */
export async function ensureDefaultWarehouseIn(
  em: EntityManager,
  organizationId: string,
): Promise<ProvisionedLocation> {
  const existing: { id: string }[] = await em.execute(
    `select id from inventory_locations where organization_id = ? and is_default and kind = 'WAREHOUSE'`,
    [organizationId],
  );
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row]: { id: string }[] = await em.execute(
    `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
     values (?, 'WAREHOUSE', ?, 'Main warehouse', null, true, now(), now()) returning id`,
    [organizationId, defaultWarehouseCode(organizationId)],
  );
  return { id: row.id, created: true };
}

/**
 * One STORE custody location per branch; branch-level stock lands here.
 *
 * `code` is derived from the store's immutable id, never its slug or name — a
 * slug is a mutable label, and renamable identity is not identity. The NAME is
 * a label and may follow the store's name at creation; it is never parsed.
 */
export async function ensureStoreCustodyIn(
  em: EntityManager,
  organizationId: string,
  store: { id: string; name: string },
): Promise<ProvisionedLocation> {
  const existing: { id: string }[] = await em.execute(
    `select id from inventory_locations where organization_id = ? and store_id = ?::uuid and kind = 'STORE'`,
    [organizationId, store.id],
  );
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row]: { id: string }[] = await em.execute(
    `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
     values (?, 'STORE', ?, ?, ?::uuid, false, now(), now()) returning id`,
    [organizationId, storeLocationCode(store.id), `${store.name} custody`, store.id],
  );
  return { id: row.id, created: true };
}

/**
 * Everything an organization's current stores require: the default warehouse
 * and one custody location per EXISTING store. This is what the operator
 * bootstrap has always done, and it keeps that contract exactly.
 *
 * Stores are visited in id order so two concurrent bootstraps of the same
 * organization (which the operator CLI does not serialise) take their unique
 * indexes in the same order and cannot deadlock.
 */
export async function provisionOrganizationLocationsIn(
  em: EntityManager,
  organizationId: string,
): Promise<{ warehouseId: string; storeLocationIds: string[]; createdIds: string[] }> {
  const createdIds: string[] = [];
  const warehouse = await ensureDefaultWarehouseIn(em, organizationId);
  if (warehouse.created) createdIds.push(warehouse.id);

  /**
   * `removed_at is null` (#293): a removed branch must not be given custody of
   * stock. Provisioning is idempotent and runs on onboarding, on backfill and
   * on the warehouse repair path, so without this a removed store would quietly
   * acquire a fresh inventory location the next time any of them ran — and a
   * location, once created, can never be re-pointed away from its store.
   */
  const stores: { id: string; name: string }[] = await em.execute(
    `select id, name from stores where organization_id = ? and removed_at is null order by id`,
    [organizationId],
  );
  const storeLocationIds: string[] = [];
  for (const store of stores) {
    const custody = await ensureStoreCustodyIn(em, organizationId, store);
    storeLocationIds.push(custody.id);
    if (custody.created) createdIds.push(custody.id);
  }
  return { warehouseId: warehouse.id, storeLocationIds, createdIds };
}
