import { Collection, Entity, OneToMany, PrimaryKey, Property } from '@mikro-orm/core';
import { Store } from '../../stores/entities/store.entity';

/**
 * The tenant boundary (P0-01).
 *
 * A Store used to mean company, branch, website, billing, tax identity and
 * permissions all at once, so there was no way to say that two stores belong
 * to the same client — and nothing structural stopped a query from reading
 * across them. An Organization is the client; a Store is one of its branches
 * or sales channels.
 *
 * Everything a client owns should hang off organizationId. Store keeps only
 * what genuinely differs per branch.
 */
/**
 * #294 (P3): a company is REMOVABLE. `@Filter(removedFilterDef)` is the
 * boundary, default-on, exactly as it is for users, items, categories and
 * branches (ADR 019): every ordinary `find`/`findOne`/`count` excludes a
 * removed company with no caller predicate, and only `INCLUDING_REMOVED` sees
 * one. Two consequences the slice designs for rather than discovers:
 *
 *   - the relation toward Organization is NULLABLE on stores, users, products,
 *     categories, store_products and sales_orders, so those rows stay visible
 *     with a null owner and every platform-wide read of them excludes removed
 *     companies EXPLICITLY (the Clients overview, Platform Users, the lookups,
 *     the merge counts);
 *   - the authentication boundary never reads a company's lifecycle from the
 *     populated relation — a relation that resolves to null is NOT an active
 *     company — but from the member's stored `organization_id`
 *     (`readMemberOrganizationLifecycle`).
 */
@Entity({ tableName: 'organizations' })
export class Organization {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property()
  name!: string;

  @Property({ unique: true })
  slug!: string;

  /**
   * The language the CANONICAL catalogue copy is written in (ADR 013 §11).
   *
   * `products.name/description/meta_*` and their category counterparts are
   * this language; every other language lives in a translation row beside the
   * item, never as a duplicate item. Seeded `es` for the four existing
   * organizations (decision 13) as an initial CONFIGURABLE default — it is
   * not a permanent restriction and not a claim that a client sells only in
   * Spanish.
   */
  @Property({ length: 20, default: 'es' })
  defaultContentLocale: string = 'es';

  /** Commercial plan of the client (see plans.ts). Billing is per client. */
  @Property({ default: 'BASICO' })
  plan: string = 'BASICO';

  /** Optional contractual monthly price; NULL uses the plan catalogue price. */
  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  monthlyPriceUsdOverride?: string;

  /** Plan key to which the contractual price override applies. */
  @Property({ nullable: true })
  monthlyPriceOverridePlan?: string;

  /**
   * PENDING_FIRST_PAYMENT = new client, panel read-only until they pay;
   * ACTIVE = paid up; SUSPENDED = subscription died, read-only again.
   * Public websites are never affected — only the admin panel.
   */
  @Property({ default: 'ACTIVE' })
  billingStatus: string = 'ACTIVE';

  /** Stripe identity of the CLIENT (P0-09). One customer per company. */
  @Property({ nullable: true })
  stripeCustomerId?: string;

  @Property({ nullable: true })
  stripeSubscriptionId?: string;

  /**
   * The subscription that last ENDED for this company (#248, PR B). Kept so a
   * late event about a former subscription is recognisable without asking
   * Stripe; moved here by the deletion handler when it clears the current id.
   */
  @Property({ nullable: true })
  stripePreviousSubscriptionId?: string;

  @OneToMany(() => Store, (store) => store.organization)
  stores = new Collection<Store>(this);

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();

  /** Soft-archive, matching how stores and products are retired. */
  @Property({ nullable: true })
  archivedAt?: Date;

  /** Internal lifecycle marker retained for legacy integrity guards. */
  @Property({ type: 'timestamptz', nullable: true })
  removedAt?: Date | null;

  /**
   * P5-X1 — set while this organization is frozen for the inventory cutover.
   *
   * NULL means unfrozen, which is why the column needs no default. While it is
   * set, `InventoryPostingService` refuses every ordinary posting and admits
   * only the OPENING_BALANCE epoch; who froze it is in the audit log, not here.
   */
  @Property({ nullable: true })
  inventoryCutoverFrozenAt?: Date;

  // ── the merge record (#289 P1, columns defined by Migration20260913120000) ──
  //
  // Written only by `OrganizationMergeService`, in the same transaction that
  // retags the source's records and archives it. Both are null or both are
  // set; the database's check constraint says so, not just this comment.
  // Nothing else writes them, and nothing clears them: a merge is a fact about
  // where a company's records went, and it stays true after the fact.

  /** The organization this one was merged INTO. Null unless merged. */
  @Property({ type: 'uuid', nullable: true })
  mergedIntoOrganizationId?: string | null;

  @Property({ type: 'timestamptz', nullable: true })
  mergedAt?: Date | null;

  // ---- Removal lifecycle (#294, the ADR 019 contract) ----




  /**
   * Mapped because the registry requires all five lifecycle columns; NEVER
   * written by organization removal, which releases nothing: the archived
   * stamp stays on the row and answers "was it archived when removed".
   */
}
