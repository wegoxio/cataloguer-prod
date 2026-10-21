import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { COMPANY_NAME_MAX, PERSON_NAME_MAX } from '../../../common/validation/field-limits';

/**
 * The body of `POST /organizations/:id/administrators` (Phase 4).
 *
 * DELIBERATELY MINIMAL. There is no `role`, no `storeId` and no
 * `organizationId` property, and the route is validated with
 * `forbidNonWhitelisted`, so supplying any of them is a 400 that NAMES the
 * offending property rather than a silent strip. That matters: a body quietly
 * stripped of `role: 'SUPER_ADMIN'` looks identical to one that never sent it,
 * and the caller would have no way to learn the escalation was refused.
 *
 * The role is a constant in the service and the organization comes from the
 * path, so neither is expressible here by construction.
 */
export class CreateOrganizationAdministratorDto {
  /**
   * 320 (RFC 5321) against a `varchar(255)` column. Pre-existing, and left
   * alone deliberately — #276's onboarding route uses the column's bound.
   */
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSON_NAME_MAX)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSON_NAME_MAX)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COMPANY_NAME_MAX)
  company?: string;
}
