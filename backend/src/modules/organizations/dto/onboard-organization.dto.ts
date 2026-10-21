import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { PLANS } from '../../stores/plans';
import {
  COMPANY_NAME_MAX,
  EMAIL_MAX,
  PERSON_NAME_MAX,
  STORE_NAME_MAX,
  WEBSITE_URL_MAX,
} from '../../../common/validation/field-limits';

/**
 * The plan list is READ FROM THE PLAN REGISTRY, not retyped. A hand-copied list
 * is how a plan gets added to billing and silently refused at onboarding.
 */
const PLAN_KEYS = Object.keys(PLANS);

export class OnboardOrganizationFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(COMPANY_NAME_MAX)
  name!: string;

  /** Optional; the organization entity's own default applies when absent. */
  @IsOptional()
  @IsIn(PLAN_KEYS)
  plan?: string;
}

export class OnboardStoreFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(STORE_NAME_MAX)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(WEBSITE_URL_MAX)
  websiteUrl?: string;
}

export class OnboardManagerFieldsDto {
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSON_NAME_MAX)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSON_NAME_MAX)
  lastName?: string;
}

/**
 * ONE STATEMENT OF A NEW CLIENT.
 *
 * There is deliberately NO `role` field, and its absence is the point. The
 * panel used to post `role: 'ADMIN'` with a `storeId` as the third of three
 * requests, which is how every company onboarded through the UI ended up with a
 * branch administrator and no manager. A client cannot name the first user's
 * role here because there is only one correct answer: the backend always
 * creates an ORGANIZATION_MANAGER with no store.
 *
 * `store` is optional in the CONTRACT — a manager is organization-wide and
 * needs no branch — while the onboarding screen continues to send one, because
 * that is its product flow (owner decision D2). API optionality must not
 * quietly remove the store from the experience.
 *
 * VALIDATION COMPATIBILITY. Every bound here comes from
 * `common/validation/field-limits.ts`, which the store and administrator routes
 * import too, so re-declaring these fields cannot widen them by accident. The
 * intentional differences, all narrowing, are:
 *
 *   - `organization.name` is capped at 200. `CreateOrganizationDto` has NO cap,
 *     so `POST /organizations` turns a 300-character name into a database error
 *     instead of a 400. Onboarding copies that name into `users.company`, whose
 *     other writer caps it at 200, so 200 is the bound that keeps both columns
 *     and both routes consistent.
 *   - `store.websiteUrl` is capped at 255, the column, not `CreateStoreDto`'s 300.
 *   - `manager.email` is capped at 255, the column, not
 *     `CreateOrganizationAdministratorDto`'s 320.
 *
 * There is no `company` field: onboarding derives it from the organization name
 * rather than letting the caller state a third, possibly different, company.
 * And `billingStatus`, which `CreateOrganizationDto` exposes, is absent — a
 * brand-new client's billing state is not a client-supplied value.
 */
export class OnboardOrganizationDto {
  @ValidateNested()
  @Type(() => OnboardOrganizationFieldsDto)
  organization!: OnboardOrganizationFieldsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardStoreFieldsDto)
  store?: OnboardStoreFieldsDto;

  @ValidateNested()
  @Type(() => OnboardManagerFieldsDto)
  manager!: OnboardManagerFieldsDto;
}
