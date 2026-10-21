import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { ProductFieldDefinition } from './product-field-definition.entity';

/**
 * Whether ONE branch uses an organization's field, and how (B4a).
 *
 * The definition says what "Color" means; this says whether this branch shows
 * it, demands it, orders it, and lets imports recognise it. A missing row
 * means "not activated" — adding a definition changes nothing anywhere until a
 * branch opts in.
 *
 * `required` blocks PUBLICATION, never ordinary editing: values are
 * organization-owned data, while requiring one is branch policy. A product
 * missing a required value cannot be published in that store, and enabling
 * `required` is refused while published products would violate it. Nothing is
 * ever silently unpublished.
 *
 * `organization` is denormalized so composite foreign keys can refuse, in the
 * database, a row pairing another account's definition with this store.
 * It must always equal both the definition's and the store's organization.
 */
@Entity({ tableName: 'store_field_settings' })
@Unique({ properties: ['store', 'definition'] })
export class StoreFieldSetting {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /** Denormalized by contract: always the definition's and the store's. */
  @ManyToOne(() => Organization, { deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => Store, { deleteRule: 'cascade' })
  store!: Store;

  @ManyToOne(() => ProductFieldDefinition, { deleteRule: 'restrict' })
  definition!: ProductFieldDefinition;

  /** Opt-in. The three flags below are refused while this is false. */
  @Property({ type: 'boolean', default: false })
  active: boolean = false;

  /** Blocks publication in this store when the value is missing. */
  @Property({ type: 'boolean', default: false })
  required: boolean = false;

  @Property({ type: 'boolean', default: false })
  publiclyVisible: boolean = false;

  /** Import may recognise a column for this field and PROPOSE a mapping. */
  @Property({ type: 'boolean', default: false })
  importable: boolean = false;

  /**
   * Phase 6 readiness: this branch intends the field as a public filter.
   * Metadata only in Phase 2 — no query surface reads it yet. Refused while
   * inactive, like every other flag.
   */
  @Property({ type: 'boolean', default: false })
  filterable: boolean = false;

  /** This branch's own ordering; null falls back to the definition's. */
  @Property({ type: 'integer', nullable: true })
  sortOrder?: number | null;

  /** Presentation override; null falls back to the definition's label. */
  @Property({ length: 120, nullable: true, fieldName: 'label_override' })
  labelOverride?: string | null;

  /** Presentation override; null falls back to the definition's group. */
  @Property({ length: 64, nullable: true, fieldName: 'group_override' })
  groupOverride?: string | null;

  /**
   * Display-only unit for a CURATED NUMBER definition: must belong to the
   * same registry unit family as the canonical unit. The stored value is
   * NEVER rewritten — conversion happens at serialization. Refused for
   * CUSTOM definitions (no known conversion) and non-NUMBER types.
   */
  @Property({ length: 24, nullable: true, fieldName: 'display_unit' })
  displayUnit?: string | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
