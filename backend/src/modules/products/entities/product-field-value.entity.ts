import { Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from './product.entity';
import { ProductFieldDefinition, ProductFieldType } from './product-field-definition.entity';

/**
 * What ONE product answers for ONE field (B4a).
 *
 * Values are product-owned. A standalone item and a child each carry their
 * own; a family card may carry descriptive values of its own but NEVER
 * supplies a fallback to its children — the same rule B3 established for lead
 * time. Absence means absence, never "ask the parent".
 *
 * TYPE AGREEMENT WITHOUT A TRIGGER: `definitionType` is denormalized here and
 * pinned to its definition by a composite foreign key over
 * (definition, organization, type), while a CHECK ties that type to exactly
 * one populated value column. The database therefore refuses a NUMBER value
 * stored as text, and refuses changing a definition's type while values exist
 * — even from direct SQL.
 *
 * `organization` is likewise denormalized by contract and must always equal
 * both the definition's and the product's.
 */
@Entity({ tableName: 'product_field_values' })
@Unique({ properties: ['product', 'definition'] })
export class ProductFieldValue {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /** Denormalized by contract: always the definition's and the product's. */
  @ManyToOne(() => Organization, { deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => Product, { deleteRule: 'cascade' })
  product!: Product;

  @ManyToOne(() => ProductFieldDefinition, { deleteRule: 'restrict' })
  definition!: ProductFieldDefinition;

  /** Mirror of the definition's type, pinned by composite FK. Never edited. */
  @Enum({ items: () => ProductFieldType })
  definitionType!: ProductFieldType;

  /** Exactly one of the three is populated, matching definitionType. */
  @Property({ type: 'text', nullable: true })
  valueText?: string | null;

  @Property({ type: 'decimal', precision: 18, scale: 6, nullable: true })
  valueNumber?: string | null;

  @Property({ type: 'boolean', nullable: true })
  valueBoolean?: boolean | null;

  /**
   * DATE only: a calendar date with no time and no timezone. Travels as an
   * ISO `YYYY-MM-DD` string end to end; the driver may hydrate a Date, which
   * `readFieldValue` normalizes back to the ISO string.
   */
  @Property({ columnType: 'date', nullable: true, fieldName: 'value_date' })
  valueDate?: string | Date | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
