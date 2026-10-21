import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SUPPORTED_TRANSFORMATIONS, TransformationKind } from '../transform/transformations';
import { IMPORT_COMMIT_BODY_LIMIT_BYTES } from '../../../common/http/body-limits';
import { MAX_MAPPING_COLUMNS, MAX_SAMPLE_ROWS as SHARED_MAX_SAMPLE_ROWS } from '../shared/import-limits';

/**
 * Request shapes for the mapping wizard.
 *
 * The global pipe runs with `whitelist` and `forbidNonWhitelisted`, so anything
 * without a decorator is stripped and anything unexpected is refused. That is
 * the behaviour we want, but it has a sharp edge: a free-form nested object —
 * transformation `options`, which legitimately differ per operation — vanishes
 * silently unless it is explicitly allowed. `@Allow()` marks those, and only
 * those.
 *
 * Sizes are bounded here rather than left to the body limit alone. The body
 * limit stops a request that is too large; these stop a request that is the
 * right size and still absurd — twelve thousand columns, a mapping naming a
 * column index of two billion.
 */

/** Beyond this many columns a spreadsheet is not a table anyone is mapping. */
export const MAX_COLUMNS = MAX_MAPPING_COLUMNS;

/** Sample rows the editor re-previews as the mapping changes. */
export const MAX_SAMPLE_ROWS = SHARED_MAX_SAMPLE_ROWS;

export class TransformationDto {
  @IsIn(SUPPORTED_TRANSFORMATIONS)
  kind!: TransformationKind;

  /**
   * Per-operation configuration. Deliberately unvalidated in shape — each
   * operation reads what it understands and ignores the rest, and every one of
   * them is total. Validating here would duplicate that knowledge in a second
   * place that could disagree with it.
   */
  @IsOptional()
  @Allow()
  options?: Record<string, unknown>;
}

export class ColumnMappingDto {
  @IsInt()
  @Min(0)
  columnIndex!: number;

  @IsString()
  @MaxLength(512)
  header!: string;

  /**
   * `null` means "ignore this column", which is a decision rather than an
   * absence — so it is accepted explicitly instead of being left off.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  field!: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => TransformationDto)
  transformations?: TransformationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  reasons?: string[];

  @IsOptional()
  @IsBoolean()
  reviewed?: boolean;
}

export class TableMappingDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  sheet?: string;

  @IsInt()
  @Min(1)
  headerRow!: number;

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @ValidateNested({ each: true })
  @Type(() => ColumnMappingDto)
  columns!: ColumnMappingDto[];
}

/**
 * The bounded slice of the file the editor works against.
 *
 * The editor re-previews as the mapping changes, and doing that by re-reading a
 * hundred-megabyte source from private storage on every keystroke would be
 * absurd. Analysis returns a sample; the editor sends it back with each
 * candidate mapping. The rows are the customer's own data returning to them,
 * so nothing is disclosed that they did not already have.
 */
export class SourceSampleDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  sheet?: string;

  /** Spreadsheet row number of the first sampled row, so anchors are real. */
  @IsInt()
  @Min(1)
  firstRowNumber!: number;

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  headers!: string[];

  @IsArray()
  @ArrayMaxSize(MAX_SAMPLE_ROWS)
  @Allow()
  rows!: string[][];
}

export class PreviewMappingDto {
  @IsIn(['PRODUCTS', 'CATEGORIES', 'HISTORICAL_STORE_SALES'])
  importType!: string;

  @ValidateNested()
  @Type(() => SourceSampleDto)
  sample!: SourceSampleDto;

  @ValidateNested()
  @Type(() => TableMappingDto)
  mapping!: TableMappingDto;
}

export class SaveTemplateDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsIn(['PRODUCTS', 'CATEGORIES', 'HISTORICAL_STORE_SALES'])
  importType!: string;

  @ValidateNested()
  @Type(() => TableMappingDto)
  mapping!: TableMappingDto;

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  headers!: string[];

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  types!: string[];
}

export class ApplyTemplateDto {
  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  headers!: string[];

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  types!: string[];
}

/**
 * A crude guard on total sample size.
 *
 * `ArrayMaxSize` bounds the row and column counts but says nothing about cell
 * length, so two hundred rows of two-megabyte cells would pass every decorator
 * above. The body limit catches it first in practice; this makes the intent
 * explicit and independent of that configuration.
 */
export function sampleWithinBudget(sample: SourceSampleDto): boolean {
  let bytes = 0;
  for (const row of sample.rows ?? []) {
    for (const cell of row ?? []) {
      bytes += (cell ?? '').length;
      if (bytes > IMPORT_COMMIT_BODY_LIMIT_BYTES) return false;
    }
  }
  return true;
}
