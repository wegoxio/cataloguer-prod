import { Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from './product.entity';

/**
 * One product pointing at another: accessories, similar items, replacements
 * (Phase 3).
 *
 * DIRECTED BY DESIGN. "This chair suggests that cushion" is not the same
 * statement as "this cushion suggests that chair" — they may carry different
 * types and different positions in their own lists. A reciprocal pair is
 * therefore TWO rows, created together in one transaction only when the
 * request explicitly asks for it, never inferred from a single edge.
 *
 * TENANT INTEGRITY is enforced by composite foreign keys over
 * (source, organization) and (target, organization): a row linking two
 * companies' products cannot exist, even from direct SQL.
 *
 * SCHEMA-DIFF WARNING: the composite foreign keys are invisible to MikroORM's
 * schema diff — the DDL is hand-authored in Migration20260805210000.
 */
export enum ProductRelationType {
  RELATED = 'RELATED',
  ACCESSORY = 'ACCESSORY',
  SIMILAR = 'SIMILAR',
  REPLACEMENT = 'REPLACEMENT',
}

@Entity({ tableName: 'product_relations' })
@Unique({ properties: ['sourceProduct', 'targetProduct', 'type'] })
export class ProductRelation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /** Denormalized by contract: always both products'. */
  @ManyToOne(() => Organization, { deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => Product, { deleteRule: 'cascade', fieldName: 'source_product_id' })
  sourceProduct!: Product;

  /**
   * CASCADE: when the pointed-at product is deleted the suggestion stops
   * meaning anything, so the edge goes with it. Publication filtering already
   * hides archived and unpublished targets from the public contract long
   * before deletion enters the picture.
   */
  @ManyToOne(() => Product, { deleteRule: 'cascade', fieldName: 'target_product_id' })
  targetProduct!: Product;

  @Enum({ items: () => ProductRelationType })
  type!: ProductRelationType;

  @Property({ type: 'integer', default: 0 })
  sortOrder: number = 0;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
