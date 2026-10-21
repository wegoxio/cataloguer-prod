import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Store } from '../../stores/entities/store.entity';

/**
 * A discount code a website offers its shoppers. Lives on the store
 * (managed from the website module's Descuentos tab). The website's
 * checkout validates a typed code via /public/validate-discount and the
 * order-creation endpoint re-applies it server-side.
 *
 * REMOVABLE (#295 G2), never deleted. A removed code is refused at validation
 * and checkout, leaves the discounts card and every direct read, and keeps its
 * counters for the day it is restored. Only the unscoped platform owner brings
 * it back, from Recovery.
 *
 * UNIQUENESS IS THE DATABASE'S, NOT THIS MAPPING'S. `(store, code)` is the
 * partial unique index `discount_codes_store_code_unique` over
 * `removed_at is null`, so a removed code releases its text. `@Unique` here
 * would ask the schema generator to put the total constraint back and take the
 * release away (the same reasoning as `Product`).
 */
@Entity({ tableName: 'discount_codes' })
export class DiscountCode {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Store)
  store!: Store;

  @Property()
  code!: string; // stored uppercased, unique per store

  @Property()
  type: string = 'PERCENT'; // PERCENT | FIXED

  @Property({ type: 'decimal', precision: 10, scale: 2 })
  value!: string; // 20 (=20%) or 5.00 (=$5)

  // ORDER = whole cart · PRODUCTS = only listed products · CATEGORIES = only listed categories
  @Property()
  appliesTo: string = 'ORDER';

  @Property({ type: 'json' })
  productIds: string[] = [];

  @Property({ type: 'json' })
  categoryIds: string[] = [];

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  minOrderUsd?: string;

  @Property({ nullable: true })
  maxUses?: number;

  @Property()
  usedCount: number = 0;

  @Property({ nullable: true })
  expiresAt?: Date;

  @Property()
  active: boolean = true;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  /** Internal lifecycle marker; no recovery surface is exposed. */
  @Property({ type: 'timestamptz', nullable: true })
  removedAt?: Date | null;



  /** The remover's email AS RECORDED AT THE TIME. Never rewritten. */


  /**
   * Holds the code text a removal RELEASED, so Recovery can say which live
   * code now holds it. Never returned to a tenant.
   */
}
