import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CartItemDto } from './cart-item.dto';

/**
 * Manual sale entry (#173): sales agreed by phone or in person. The
 * owner may name the store; branch users omit it (the service derives it).
 * Bounds match the service's own truncation (customerName 120, phone 40) and
 * the priceCart item cap (100).
 */
export class CreateManualSaleDto {
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
