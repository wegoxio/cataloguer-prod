import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { LocationKind } from '../ledger/inventory.types';

/**
 * Where an organization's stock physically is (ADR 013 §3).
 *
 * Two kinds, one table. A WAREHOUSE is internal and is NEVER a catalogue
 * channel — channel membership lives in `store_products` and nothing here can
 * create it. A STORE location is custody AT a branch, which is a different
 * thing from the branch's role as a sales channel (ADR 007): the branch decides
 * what it SHOWS, the location records what it HOLDS.
 *
 * Design A was chosen over separate warehouse/store projections because
 * `stores_id_organization_id_unique` already exists, so the tenant-safe
 * composite reference costs no new key, and because one table means
 * warehouse->store and store->store transfers are the same transaction type
 * over two `location_id` endpoints instead of two structurally different flows.
 *
 * Identity is immutable after creation — `code`, `organization`, `kind` and
 * `store` are refused by a database trigger on UPDATE. Only `name`,
 * `isDefault` and `updatedAt` may change. A location that has ledger history
 * therefore keeps its identity for good, which is why a store holding custody
 * is archival rather than physically deletable (the store FK is RESTRICT).
 */
@Entity({ tableName: 'inventory_locations' })
export class InventoryLocation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @Property({ type: 'text' })
  kind!: LocationKind;

  /**
   * The immutable machine identity. For a store location this is
   * `STORE:<store-uuid>` (owner decision 3) — never derived from the slug,
   * because a slug is a mutable label and renamable identity is not identity.
   */
  @Property({ type: 'text' })
  code!: string;

  /** The mutable human label. Never an identity; never parsed. */
  @Property({ type: 'text' })
  name!: string;

  /** Set only for `kind = 'STORE'`, and constrained to that by the database. */
  @ManyToOne(() => Store, { fieldName: 'store_id', nullable: true })
  store?: Store | null;

  /**
   * Exactly one default WAREHOUSE per organization.
   *
   * The partial unique index enforces AT MOST one; existence is asserted by the
   * posting mechanism, because a partial unique index cannot require a row to
   * exist. Both halves are needed and neither is claimed to do the other's job.
   */
  @Property({ type: 'boolean', default: false })
  isDefault: boolean = false;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
