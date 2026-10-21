import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { STORE_NAME_MAX } from '../../../common/validation/field-limits';

export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_NAME_MAX)
  name!: string;

  /**
   * The client this branch belongs to (P0-01). Optional in the DTO only so
   * that older callers fail with a clear message from the service rather than
   * a validation error that does not say why.
   */
  @IsUUID()
  @IsOptional()
  organizationId?: string;

  @IsString()
  @IsOptional()
  slug?: string;

  /**
   * 300 against a `varchar(255)` column: a 260-character URL is accepted here
   * and then fails in the database. Pre-existing, and left alone deliberately —
   * narrowing an existing route is its own compatibility decision. #276's
   * onboarding route uses the column's bound instead of inheriting this one.
   */
  @IsString()
  @IsOptional()
  @MaxLength(300)
  websiteUrl?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  websiteProductPath?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  websiteCategoryPath?: string;
}

export class UpdateStoreDto {
  @IsString()
  @IsOptional()
  @MaxLength(STORE_NAME_MAX)
  name?: string;

  // Settings → Customization: standard modules hidden from the sidebar
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hiddenModules?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(200)
  contactEmail?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  contactPhone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  contactAddress?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  websiteUrl?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  websiteProductPath?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  websiteCategoryPath?: string;
}
