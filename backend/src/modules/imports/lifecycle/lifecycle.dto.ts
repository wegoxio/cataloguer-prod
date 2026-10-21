import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IMPORT_TYPES } from './import-lifecycle.service';
import { SourceSampleDto, TableMappingDto, MAX_COLUMNS } from '../wizard/wizard.dto';

/**
 * Request shapes for the import lifecycle.
 *
 * The global pipe runs with `whitelist` and `forbidNonWhitelisted`, so every
 * accepted field is declared here and anything else is refused rather than
 * ignored. Identifiers are `@IsUUID` because we mint them: a value that is not
 * a UUID did not come from us, and letting it reach a query would send it to
 * the database as though it had.
 *
 * Nothing here accepts an organization id. The caller's tenancy comes from
 * their resolved scope, never from the body — a request that could name its own
 * organization is a request that could name somebody else's.
 */

export class CreateUploadTicketDto {
  @IsString()
  @MaxLength(512)
  fileName!: string;

  @IsString()
  @MaxLength(255)
  contentType!: string;

  /** The size the browser will be permitted to send, signed into the ticket. */
  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  maxBytes!: number;
}

export class RegisterSourceDto {
  /**
   * The server-minted key from the upload ticket.
   *
   * Echoed back rather than re-derived, and checked against the caller's tenant
   * segment before anything is read.
   */
  @IsString()
  @MaxLength(512)
  objectKey!: string;

  @IsString()
  @MaxLength(512)
  originalFileName!: string;

  @IsInt()
  @Min(0)
  sizeBytes!: number;

  /** What the client believes it uploaded. Verified against the bytes. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contentHash?: string;

  @IsString()
  @MaxLength(32)
  detectedFormat!: string;
}

export class CompleteAnalysisDto {
  @IsOptional()
  @Allow()
  tables?: unknown;

  @IsOptional()
  @Allow()
  proposals?: unknown;

  @IsOptional()
  @IsArray()
  @Allow()
  findings?: unknown[];

  @IsInt()
  @Min(0)
  rowsAnalyzed!: number;

  @IsInt()
  @Min(0)
  cellsAnalyzed!: number;
}

export class CreatePlanDto {
  @IsUUID()
  sourceId!: string;

  @IsIn(IMPORT_TYPES)
  importType!: string;

  @ValidateNested()
  @Type(() => TableMappingDto)
  mapping!: TableMappingDto;

  /**
   * Families, categories, specifications, assets, relations, translations and
   * shops. Free-form in shape because each rule kind has its own, and the
   * relationship validator is the one place that knows them.
   */
  @IsOptional()
  @Allow()
  relationships?: unknown;

  @ValidateNested()
  @Type(() => SourceSampleDto)
  sample!: SourceSampleDto;

  @IsArray()
  @ArrayMaxSize(MAX_COLUMNS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  columnTypes!: string[];

  /** Required for historical store sales; refused if outside the caller's scope. */
  @IsOptional()
  @IsUUID()
  storeId?: string;

  /** Warnings the person has read and accepted. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  acknowledgedIssueCodes?: string[];
}

export class StartExecutionDto {
  /**
   * The single-use proof the approval returned.
   *
   * Never logged and never echoed back: for its lifetime it is a bearer
   * credential for a catalogue-wide write.
   */
  @IsString()
  @MaxLength(256)
  proof!: string;
}

export class RowResultsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
