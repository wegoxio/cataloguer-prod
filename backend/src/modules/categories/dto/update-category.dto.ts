import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  Matches,
  ValidateIf,
} from 'class-validator';
import { CategoryKind } from '../entities/category.entity';

/**
 * Every property carries a decorator; the global pipe rejects undecorated ones.
 *
 * `kind` and `publicLabel` accept an explicit null so a value
 * can be CLEARED — `@ValidateIf` skips the type check for null only, which is
 * how "unset it" stays distinguishable from "leave it alone" (undefined).
 */
export class UpdateCategoryDto {
  @IsString()
  @IsOptional()
  source?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers, and hyphens',
  })
  @IsOptional()
  slug?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(160)
  @IsOptional()
  metaTitle?: string;

  @IsString()
  @MaxLength(300)
  @IsOptional()
  metaDescription?: string;

  @IsUUID()
  @IsOptional()
  parentCategoryId?: string;

  // ---------- Phase 4: presentation metadata ----------

  @ValidateIf((_, value) => value !== null)
  @IsEnum(CategoryKind)
  @IsOptional()
  kind?: CategoryKind | null;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @IsOptional()
  publicLabel?: string | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  showInNavigation?: boolean;

}
