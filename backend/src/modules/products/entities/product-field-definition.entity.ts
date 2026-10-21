import { Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * What a field value may hold.
 *
 * Phase 2 additions: SELECT (one of the definition's `options`, stored as
 * text), DATE (calendar date, no time, no timezone), URL (absolute http(s),
 * stored as text). Rich text is deliberately ABSENT — no approved sanitizer
 * exists in this repository, and serving unsanitized HTML through the public
 * API would be an XSS liability. Plain TEXT carries that content meanwhile.
 */
export enum ProductFieldType {
  TEXT = 'TEXT',
  NUMBER = 'NUMBER',
  BOOLEAN = 'BOOLEAN',
  SELECT = 'SELECT',
  DATE = 'DATE',
  URL = 'URL',
}

/** Where a definition came from: the curated registry, or this tenant. */
export type FieldDefinitionSource = 'CURATED' | 'CUSTOM';

/** Which side of a family may hold DIRECT values for a definition. */
export type FieldApplicability = 'PARENT' | 'CHILD' | 'BOTH';

/**
 * A field the ORGANIZATION defines once (B4a).
 *
 * "Color" must mean the same thing in every branch of one account, so the
 * definition is organization-scoped. Whether a branch uses it — and whether it
 * is required, public or import-recognised — is a store decision and lives in
 * StoreFieldSetting. What a product answers lives in ProductFieldValue.
 *
 * IMMUTABLE AFTER CREATION: `key` and `type`.
 *  - `type` is pinned by a composite foreign key from every value row, so the
 *    database refuses to change it while values exist.
 *  - `key` immutability is a SERVICE and DTO rule only; the schema cannot tell
 *    a rename from a corruption. Direct SQL must never update either column.
 * Renaming a field means creating a new key, which is exactly how two stores
 * that genuinely mean different things by "Size" stay distinguishable.
 *
 * Archiving preserves identity: the (organization, key) unique constraint is
 * NOT partial on archivedAt, so an archived definition keeps owning its key
 * and the same key cannot be recreated with a different meaning.
 */
@Entity({ tableName: 'product_field_definitions' })
@Unique({ properties: ['organization', 'key'] })
export class ProductFieldDefinition {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /**
   * Never null. Unlike Product.organization — which stayed nullable for a
   * backfill — this table has no legacy rows, so tenancy is required from the
   * first row. Composite foreign keys reference (id, organization) so a
   * definition can never be paired with another account's store or product.
   */
  @ManyToOne(() => Organization, { deleteRule: 'restrict' })
  organization!: Organization;

  /** Normalized, stable identity: lowercase, `[a-z0-9-]`. Immutable. */
  @Property({ length: 64 })
  key!: string;

  /** What admins and customers see. Freely editable; carries display casing. */
  @Property({ length: 120 })
  label!: string;

  /** Immutable once values exist — enforced by composite FK. */
  @Enum({ items: () => ProductFieldType })
  type!: ProductFieldType;

  /**
   * The CANONICAL unit every stored number means, org-wide. Only meaningful
   * for NUMBER. Immutable while values exist (service rule): changing it
   * would silently reinterpret every stored magnitude. Stores may present a
   * different unit via StoreFieldSetting.displayUnit — display conversion,
   * never reinterpretation.
   */
  @Property({ length: 24, nullable: true })
  unit?: string | null;

  /**
   * Provenance: a CURATED definition was materialized from the code registry
   * (its `key` is the registry key, and registry constraints/unit families
   * apply); CUSTOM is tenant-authored. Immutable except through the explicit
   * adoption operation (CUSTOM -> CURATED when compatible).
   */
  @Property({ type: 'text', default: 'CUSTOM' })
  source: FieldDefinitionSource = 'CUSTOM';

  /** Canonical presentation group (e.g. "dimensions"); stores may override. */
  @Property({ length: 64, nullable: true, fieldName: 'field_group' })
  fieldGroup?: string | null;

  /**
   * Which side of a family may hold DIRECT values. Children always inherit
   * for display when the parent may hold a value (PARENT or BOTH).
   * Standalone products are their own family and satisfy every side.
   * Narrowing is refused while rows exist on the newly excluded side.
   */
  @Property({ type: 'text', default: 'BOTH' })
  applicability: FieldApplicability = 'BOTH';

  /**
   * BOTH-applicability policy: when false, family members hold parent values
   * only — children never hold direct rows and always inherit. Flipping to
   * false is refused while any child holds a direct row.
   */
  @Property({ default: true, fieldName: 'child_override_allowed' })
  childOverrideAllowed: boolean = true;

  /**
   * SELECT only: the closed list of allowed values. Immutable while values
   * exist (service rule) — shrinking it would orphan stored answers.
   */
  @Property({ type: 'json', nullable: true })
  options?: string[] | null;

  /** The organization's default ordering; a store may override its own. */
  @Property({ type: 'integer', default: 0 })
  sortOrder: number = 0;

  /** Archived definitions keep their key and their values, but disappear
   *  from admin pickers, public output and import recognition. */
  @Property({ type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
