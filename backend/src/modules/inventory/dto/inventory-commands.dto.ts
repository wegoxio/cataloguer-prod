import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Phase 8 — the operator's inventory vocabulary.
 *
 * Deliberately a set of BOUNDED DOMAIN COMMANDS, never a ledger-posting
 * endpoint. Each one names a thing an operator decided to do — "I counted the
 * shelf", "these units are damaged", "move stock between branches" — and the
 * classified posting mechanism turns it into movements. Nothing here can
 * express an arbitrary entry, and nothing here reaches the compatibility caches
 * except through that mechanism.
 *
 * Every command that CHANGES a quantity states a reason: an unexplained
 * adjustment is indistinguishable from an error when it is read back a month
 * later.
 */

const CONDITIONS = ['GOOD', 'DAMAGED'] as const;
const SELLABILITY = ['AVAILABLE', 'NON_SELLABLE'] as const;

export class RecountDto {
  @IsUUID()
  productId!: string;

  /** The location whose shelf was counted. A branch role may only name its own. */
  @IsUUID()
  locationId!: string;

  /**
   * What was actually there. This is a TARGET, not a delta — re-submitting the
   * same count posts nothing, which is what makes a recount safe to retry.
   */
  @IsInt()
  @Min(0)
  countedQuantity!: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class ConditionStateDto {
  @IsIn(CONDITIONS as unknown as string[])
  physicalCondition!: (typeof CONDITIONS)[number];

  @IsIn(SELLABILITY as unknown as string[])
  operationalState!: (typeof SELLABILITY)[number];
}

export class ReclassifyDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @ValidateNested()
  @Type(() => ConditionStateDto)
  from!: ConditionStateDto;

  @ValidateNested()
  @Type(() => ConditionStateDto)
  to!: ConditionStateDto;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ReassignStockDto {
  @IsUUID()
  sourceProductId!: string;

  @IsUUID()
  destinationProductId!: string;

  @IsUUID()
  locationId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class FamilyAllocationDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class DistributeFamilyStockDto {
  /** The family card holding the stock. Only its own children may receive. */
  @IsUUID()
  rootProductId!: string;

  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => FamilyAllocationDto)
  allocations!: FamilyAllocationDto[];

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class TransferLineDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsIn(CONDITIONS as unknown as string[])
  physicalCondition?: (typeof CONDITIONS)[number];
}

export class CreateTransferDto {
  @IsUUID()
  sourceLocationId!: string;

  @IsUUID()
  destinationLocationId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  lines!: TransferLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

/**
 * A partial leg. Absent quantities mean "the whole outstanding line", which is
 * the ordinary case; naming them is how a partial dispatch or arrival is
 * expressed.
 */
export class TransferQuantitiesDto {
  @IsOptional()
  quantities?: Record<string, number>;
}
