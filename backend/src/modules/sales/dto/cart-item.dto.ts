import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * One line of a cart (#173). The single contract shared by every surface that
 * prices a cart: the public website order, the manual-sale entry and the
 * discount preview — all consume `sales.service.PublicOrderItem`.
 *
 * quantity is capped at 10,000: the customer/manual-sales scale (procurement
 * uses a separate, larger bound in SupplierOrderItemDto).
 */
export class CartItemDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  quantity!: number;
}
