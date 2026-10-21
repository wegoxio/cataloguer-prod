import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A sales channel (ADR 007): each store owns its website connection and,
 * from P7.2 on, selects which products it shows and owns its API keys.
 *
 * THREE STATES, NOT TWO (#293). `archivedAt` is unchanged and remains the
 * tenant's own reversible switch: an archived store stays in the panel, stays
 * listed when the tenant asks for it, and the tenant turns it back on. Slice D
 * layers `removedAt` above it — strictly stronger, invisible to the tenant
 * entirely, and reversible only by an unscoped platform administrator through
 * Recovery. The two are never collapsed into one "hidden" flag and a removal
 * never writes `archivedAt`, so a store removed while archived comes back
 * archived.
 *
 * `@Filter(removedFilterDef)` is the boundary, default-on, exactly as it is for
 * users, items and categories. Every `find`, `findOne`, `count` and populate
 * excludes a removed store because the ORM adds the clause.
 *
 * WHAT THE FILTER DOES NOT DO: it does not, by itself, stop a removed store's
 * API key from authenticating. `ApiKey.store` is a NULLABLE many-to-one, and
 * the filter's behaviour for a nullable relation is to keep the owning row and
 * null the link — the key row is still found by its hash. An earlier draft of
 * this comment claimed the opposite (that the relation was required and the
 * populate would fail); a mutation that deleted the explicit check left the
 * key authenticating, and the claim was withdrawn. Authentication is protected
 * by the explicit, refreshed lifecycle read in `ApiKeysService.verify`, and by
 * nothing implicit. `store-removal.pg.spec.ts` pins that premise directly.
 *
 * `slug` STAYS TOTAL-UNIQUE ON PURPOSE. Unlike every earlier slice, removal
 * does NOT release this identifier — see `Migration20260912120000` for why the
 * brief asks for it and what it makes unreachable.
 */
@Entity({ tableName: 'stores' })
export class Store {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property()
  name!: string;

  @Property({ unique: true })
  slug!: string;

  /**
   * The client this branch belongs to (P0-01). Nullable only until the
   * backfill in #192 gives every existing store an organization; after that
   * it becomes mandatory and a store without one is a bug.
   */
  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  @Property({ nullable: true })
  websiteUrl?: string;

  @Property({ nullable: true, default: '/products/{slug}' })
  websiteProductPath?: string;

  @Property({ nullable: true, default: '/categories/{slug}' })
  websiteCategoryPath?: string;

  // Announcement pop-up the connected website shows to its visitors.
  // Catalog is the control panel; rendering is the website's job
  // (part of the integration contract, like preview tokens).
  // Pop-up stops being served after this date (null = no end date)
  // ALWAYS = every visit until expiry; ONCE = the website shows it a
  // single time per visitor (enforced website-side, e.g. localStorage)
  // Where the website shows it: ALL (every page), LANDING (home only),
  // PATH (only pages whose path matches popupPaths)
  // Comma/newline-separated paths for PATH scope, e.g. "/ofertas, /combos"
  // Company contact details, editable from Settings
  @Property({ nullable: true })
  contactEmail?: string;

  @Property({ nullable: true })
  contactPhone?: string;

  @Property({ nullable: true })
  contactAddress?: string;

  // Standard modules the company chose to hide from its own sidebar
  // (Settings → Customization). Purely visual — data stays intact.
  @Property({ type: 'json', nullable: true })
  hiddenModules?: string[];

  @Property({ nullable: true })
  archivedAt?: Date;

  /** Internal lifecycle marker; no recovery surface is exposed. */
  @Property({ type: 'timestamptz', nullable: true })
  removedAt?: Date | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  // ── the removal lifecycle (#293, columns defined by Migration20260912120000) ─
  //
  // Written only by `StoreRemovalService`, under the organization access lock,
  // the store's lifecycle lock and its row lock. Nothing else sets them.



  /** The remover's email AS RECORDED AT THE TIME. Never rewritten. */


  /**
   * MAPPED, AND DELIBERATELY NEVER WRITTEN FOR A STORE.
   *
   * A tombstone holds what removal had to RELEASE so the rest of the system
   * could carry on, and what restoration would therefore have to re-check.
   * Store removal releases nothing: the slug stays reserved by a total unique
   * index, and no relationship is detached — a store whose dependencies are
   * still live cannot be removed at all.
   *
   * The pre-removal archived/active state, which restoration does need, is not
   * recorded here either. It is already recorded by `archivedAt`, which removal
   * leaves untouched, so a store removed while archived comes back archived
   * with nothing needing to remember it. Copying a live column into a JSON blob
   * that nothing reads would be a second source of truth, and the first one to
   * go stale.
   *
   * The column exists because the registry requires every removable entity to
   * map all five lifecycle columns, and a slice that skipped one would be a
   * slice whose shape a later reader could not trust.
   */
}
