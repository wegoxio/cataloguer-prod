import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * How ONE branch sells a product (P0-06). All fields optional: assignment
 * with an empty body means "visible, base price, no stock tracking".
 */
export class BranchAssignmentDto {
  @IsBoolean()
  @IsOptional()
  published?: boolean;

  /** Branch price; null/omitted = base price applies. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  salePrice?: number | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  cost?: number | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  stockQuantity?: number;

  @IsBoolean()
  @IsOptional()
  trackInventory?: boolean;

  /**
   * Days this branch needs to deliver. Omit to leave unchanged, null to clear.
   * No upper bound: made-to-order furniture legitimately runs past a year.
   */
  @IsInt()
  @Min(0)
  @IsOptional()
  leadTimeDays?: number | null;
}
