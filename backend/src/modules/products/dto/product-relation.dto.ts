import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ProductRelationType } from '../entities/product-relation.entity';

/**
 * Directed product suggestions (Phase 3). Every property carries a decorator:
 * the global pipe rejects undecorated ones outright.
 */
export class CreateProductRelationDto {
  @IsUUID()
  targetProductId!: string;

  @IsEnum(ProductRelationType)
  type!: ProductRelationType;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * Create the mirror edge (target → source) in the SAME transaction.
   *
   * Opt-in on purpose. "This chair suggests that cushion" and "this cushion
   * suggests that chair" are two different statements a merchandiser may or
   * may not want, so reciprocity is never inferred from a single edge.
   */
  @IsOptional()
  @IsBoolean()
  reciprocal?: boolean;
}

export class UpdateProductRelationDto {
  @IsOptional()
  @IsEnum(ProductRelationType)
  type?: ProductRelationType;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * Deleting one edge leaves its mirror alone unless this says otherwise —
 * an unrequested cascade would silently delete a statement nobody asked to
 * remove.
 */
export class DeleteProductRelationDto {
  @IsOptional()
  @IsBoolean()
  includeReciprocal?: boolean;
}
