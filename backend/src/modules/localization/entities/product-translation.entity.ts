import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';

/**
 * One product's copy in ONE non-canonical language (P5-W2).
 *
 * The product itself is not duplicated — governing decision 19 and the Phase 8
 * rule "no duplicate product records per language" both require that — so this
 * row carries text and nothing else. Identity, SKU, manufacturer code, price,
 * stock, publication and channel membership stay on the product, where they
 * belong: a German shopper and a Spanish shopper are looking at the same item.
 *
 * Every field is nullable ON PURPOSE. A translator who has done the name and
 * not yet the description writes exactly that, and the resolver serves the
 * translated name beside the canonical description rather than refusing the
 * partial row or suppressing the product.
 *
 * `organization` is denormalized so the composite foreign key can let the
 * DATABASE refuse a translation filed under one company for another company's
 * product — the same reasoning `StoreProduct` records for its own pivot.
 */
@Entity({ tableName: 'product_translations' })
@Unique({ properties: ['product', 'locale'] })
export class ProductTranslation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { deleteRule: 'cascade' })
  organization!: Organization;

  @ManyToOne(() => Product, { deleteRule: 'cascade' })
  product!: Product;

  /** Canonical BCP 47 casing, e.g. `en`, `pt-BR`. Never the canonical locale. */
  @Property({ length: 20 })
  locale!: string;

  @Property({ nullable: true })
  name?: string | null;

  @Property({ nullable: true, type: 'text' })
  description?: string | null;

  @Property({ nullable: true, length: 160 })
  metaTitle?: string | null;

  @Property({ nullable: true, length: 300 })
  metaDescription?: string | null;

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();
}
