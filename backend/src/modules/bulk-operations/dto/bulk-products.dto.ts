import {
  IsArray,
  IsUUID,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsNumber,
  Min,
  IsInt,
  IsBoolean,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

/**
 * THE MOST IDS ONE BULK REQUEST MAY CARRY.
 *
 * Every one of these operations walks its ids one at a time, each with its own
 * queries and its own audit write, inside a single HTTP request. A selection
 * of ten thousand would spend minutes in one request and could pass the
 * gateway timeout AFTER writing part of the set, leaving nobody able to say
 * what had happened. A bounded request is the only shape whose outcome can be
 * reported honestly, so the client sends several and this refuses the rest.
 * It matches the limit branch publication has carried since ADR 029.
 */
export const BULK_MAX_IDS = 1000;

export class BulkArchiveRestoreDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];
}

export class BulkStatusDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];

  @IsEnum(ProductStatus)
  @IsNotEmpty()
  status!: ProductStatus;
}

export class BulkCategoryDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;
}

export class BulkInventoryDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];

  @IsInt()
  @Min(0)
  stockQuantity!: number;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;
}

export class BulkPricingDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number | null;
}

export class BulkStoresDto {
  @IsArray()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  @IsNotEmpty()
  ids!: string[];

  @IsArray()
  @IsUUID(undefined, { each: true })
  storeIds!: string[];
}

/**
 * Per-website publication in bulk (ADR 029): flips `store_products.published`
 * for many products on ONE website. Nothing else is accepted on purpose — no
 * price, stock or lead time can ride along, and the whitelist pipe refuses
 * anything extra — so the route is structurally unable to touch a branch's
 * other fields.
 *
 * At most 1,000 ids per request; the dashboard sends larger selections as
 * sequential chunks and combines the results.
 */
export class BulkBranchPublicationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  ids!: string[];

  @IsUUID()
  storeId!: string;

  @IsBoolean()
  published!: boolean;
}
