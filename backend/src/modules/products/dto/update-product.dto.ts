import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  IsUUID,
  Matches,
  IsEnum,
  IsNumber,
  Min,
  IsInt,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { ProductStatus } from '../catalogue/product-status.enum';
import { ProductSaleMode } from '../catalogue/product-sale-mode.enum';
import { StorePriceDto } from './create-product.dto';

export class UpdateProductDto {
  // Where the edit came from (audit): e.g. 'builder'
  @IsString()
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers, and hyphens',
  })
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

  @IsString()
  @IsOptional()
  sku?: string;

  /**
   * The supplier's reference (governing decision 18). Separate from `sku`,
   * never unique, and never derived from it. Blank clears it.
   */
  @IsString()
  @MaxLength(255)
  @IsOptional()
  manufacturerCode?: string;

  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @IsEnum(ProductSaleMode)
  @IsOptional()
  saleMode?: ProductSaleMode;

  @IsUUID()
  @IsOptional()
  categoryId?: string;

  /** Every category the item is reachable through. Supersedes categoryId. */
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  categoryIds?: string[];

  @IsString()
  @IsOptional()
  optionLabel?: string;

  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  storeIds?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StorePriceDto)
  @IsOptional()
  storePrices?: StorePriceDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  salePrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  cost?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  stockQuantity?: number;

  @IsBoolean()
  @IsOptional()
  trackInventory?: boolean;
}
