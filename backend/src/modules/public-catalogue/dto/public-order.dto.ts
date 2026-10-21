import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CartItemDto } from '../../sales/dto/cart-item.dto';

/**
 * Public website checkout body (#173). Formalizes the fields the controller
 * and sales service already read — including `discountCode`, previously
 * accepted only via `(body as any)`. `idempotencyKey` may also arrive in the
 * `Idempotency-Key` header (the documented path); the optional body field is
 * kept so callers that send it in the body are not rejected.
 */
export class CreatePublicOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  discountCode?: string;
}

/** Discount preview body (#173): a code plus the cart it would apply to. */
export class ValidateDiscountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  code!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
