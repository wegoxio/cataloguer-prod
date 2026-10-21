import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { PLANS as PLAN_REGISTRY } from '../../stores/plans';

/**
 * Read from the plan registry rather than retyped. The hand-copied list this
 * replaces was identical, which is exactly the state a drift starts from: a
 * plan added to billing would have been silently refused here (#276).
 */
const PLANS = Object.keys(PLAN_REGISTRY);
const BILLING_STATUSES = ['PENDING_FIRST_PAYMENT', 'ACTIVE', 'SUSPENDED'];

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(PLANS)
  @IsOptional()
  plan?: string;

  @IsIn(BILLING_STATUSES)
  @IsOptional()
  billingStatus?: string;
}

export class UpdateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsIn(PLANS)
  @IsOptional()
  plan?: string;

  @IsIn(BILLING_STATUSES)
  @IsOptional()
  billingStatus?: string;
}

export class MergeOrganizationDto {
  @IsUUID()
  sourceOrganizationId!: string;

  /**
   * True (the default) only reports what would move and what collides.
   * The commit requires an explicit false — and re-checks the conflicts
   * server-side anyway, which is the real guarantee.
   */
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;
}
