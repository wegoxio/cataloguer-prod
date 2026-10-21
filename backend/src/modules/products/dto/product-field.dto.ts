import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FieldApplicability, ProductFieldType } from '../entities/product-field-definition.entity';

/**
 * Field definition, activation and value DTOs (B4a2).
 *
 * The global pipe runs with `forbidNonWhitelisted: true`, so a property that
 * is absent from a DTO is REJECTED with 400 rather than quietly ignored. That
 * makes omission an enforcement mechanism, not just documentation — which is
 * how `key` and `type` stay immutable. (`required` was withheld this way
 * until B4a3 made publication validation real; it is writable below.)
 */

export class CreateProductFieldDto {
  /** Display name. The key is derived from this unless `key` is given. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  /**
   * Explicit stable key. Optional: normally derived from the label, but
   * required when the label has no ASCII form. Immutable once created.
   */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  key?: string;

  /** Immutable once values exist — the database enforces that. */
  @IsEnum(ProductFieldType)
  type!: ProductFieldType;

  /** Only meaningful for NUMBER. */
  @IsString()
  @IsOptional()
  @MaxLength(24)
  unit?: string | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  /** Canonical presentation group; stores may override theirs. */
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(64)
  group?: string | null;

  /** Which side of a family may hold DIRECT values. */
  @IsIn(['PARENT', 'CHILD', 'BOTH'])
  @IsOptional()
  applicability?: FieldApplicability;

  /** BOTH policy: may children override the parent's value? */
  @IsBoolean()
  @IsOptional()
  childOverrideAllowed?: boolean;

  /** SELECT only: the closed list of allowed values. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  @IsOptional()
  options?: string[];
}

/**
 * `key`, `type` and `source` are deliberately ABSENT: sending any is a 400,
 * so a field's identity, storage type and provenance cannot drift after
 * creation (adoption is the one explicit provenance transition).
 */
export class UpdateProductFieldDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  /** Null clears the unit; omitting the property leaves it unchanged. */
  @IsString()
  @IsOptional()
  @MaxLength(24)
  unit?: string | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  /** Null clears the group; omitting leaves it unchanged. */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  group?: string | null;

  /** Narrowing is refused while rows exist on the excluded side. */
  @IsIn(['PARENT', 'CHILD', 'BOTH'])
  @IsOptional()
  applicability?: FieldApplicability;

  /** Disabling is refused while any child holds a direct row. */
  @IsBoolean()
  @IsOptional()
  childOverrideAllowed?: boolean;

  /** Immutable while values exist — a shrunk list would orphan answers. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  @IsOptional()
  options?: string[];
}

/**
 * Every flag is optional and OMISSION PRESERVES the current value: the
 * service computes the FINAL state (`dto.x ?? existing.x`) and rules on that,
 * so a partial update can never flip a flag behind the caller's back.
 *
 * `required` is writable now that B4a3 validates publication. Making a field
 * effectively required (`active && required`) scans the branch's currently
 * shown products under the store's publication lock, and is refused — with a
 * bounded 409 — while any of them leaves the field unanswered.
 */
export class UpsertStoreFieldSettingDto {
  @IsBoolean()
  @IsOptional()
  active?: boolean;

  /** Blocks publication in this store when the value is missing (B4a3). */
  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @IsBoolean()
  @IsOptional()
  publiclyVisible?: boolean;

  @IsBoolean()
  @IsOptional()
  importable?: boolean;

  /** Phase 6 readiness: metadata only, no query surface reads it yet. */
  @IsBoolean()
  @IsOptional()
  filterable?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number | null;

  /** Null clears; omission preserves. Presentation only. */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  labelOverride?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  groupOverride?: string | null;

  /**
   * Display-only unit for a CURATED NUMBER definition — must belong to the
   * canonical unit's registry family. The stored value never changes.
   */
  @IsString()
  @IsOptional()
  @MaxLength(24)
  displayUnit?: string | null;
}

/**
 * One product's answer for one field.
 *
 * The shape of `value` follows the definition's type, checked in the service:
 * TEXT expects a non-blank string, BOOLEAN a real boolean, and NUMBER a plain
 * decimal STRING — never a JavaScript number, which cannot hold numeric(18,6)
 * losslessly across its range.
 */
export class UpsertProductFieldValueDto {
  // Intentionally unvalidated here: class-validator cannot express "depends on
  // the definition's type", and a permissive decorator would imply a guarantee
  // the service is actually providing.
  //
  // @Allow() is required, not decorative: the global pipe runs with
  // `whitelist` + `forbidNonWhitelisted`, which treat a property carrying no
  // decorator metadata as unknown and reject the whole request with 400. A
  // property that must survive validation untouched has to say so explicitly.
  @Allow()
  value!: string | boolean;
}
