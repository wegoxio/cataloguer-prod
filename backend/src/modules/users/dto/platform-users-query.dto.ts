import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ALL_ROLES } from '../authorization/role-levels';

/**
 * THE PLATFORM-WIDE USER LISTING'S QUERY, AND WHY IT IS ITS OWN CONTRACT.
 *
 * `GET /users` requires an organization context and refuses without one — that
 * is the tenant boundary, and Slice B does not widen it. This is a SEPARATE
 * read surface for the one actor that has no company: an UNSCOPED platform
 * owner. Its authority is checked in the service, not inferred from the absence
 * of a filter.
 *
 * FILTERING BY A ROLE IS NOT ASSIGNING IT. `SUPER_ADMIN` and `STORE_ADMIN` are
 * both listed here on purpose: a platform user list that could not show them
 * would be lying about the population it claims to describe. Neither is
 * assignable — that is `ORGANIZATION_ASSIGNABLE_ROLES`, a different list on a
 * different route, and #278 keeps `STORE_ADMIN` out of every new assignment
 * surface.
 */
export const PLATFORM_USER_STATUSES = ['active', 'deactivated', 'all'] as const;

/**
 * INVITATION STATE IS WHAT WE KNOW, NOT WHAT WE WISH WE KNEW.
 *
 * The only fact behind this filter is whether the account HAS A PASSWORD. From
 * that, exactly one thing follows: an account with no password still has an
 * outstanding invitation, and an account with one does not.
 *
 * What does NOT follow is that the person accepted anything, or ever signed in.
 * `POST /auth/reset-password` sets a password with no invitation involved, and
 * `PATCH /users/:id/password` lets an administrator set one on someone else's
 * behalf — so a row can move out of "pending" without that person doing
 * anything at all. This filter was called `accepted`, and the column read
 * "Signed in already"; both stated a fact the database does not hold.
 *
 * Hence `none`: there is no pending invitation. That is the whole claim, and it
 * is true in every case the data can produce.
 */
export const PLATFORM_INVITATION_STATES = ['pending', 'none', 'all'] as const;

/**
 * The page size ceiling. A listing whose limit a caller can raise without bound
 * is not paginated — it is a full table scan with extra steps, and #187 is
 * about exactly that. 100 is the same ceiling `findAll` already enforces.
 */
export const PLATFORM_USERS_MAX_LIMIT = 100;
export const PLATFORM_USERS_DEFAULT_LIMIT = 25;

export class PlatformUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PLATFORM_USERS_MAX_LIMIT)
  limit?: number;

  /**
   * Matched against email, first name, last name and company — the identifiers
   * a person is looked up by. Never against a password hash, a token hash or any other
   * secret: those are not searchable because they are not readable.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  storeId?: string;

  @IsOptional()
  @IsIn(ALL_ROLES)
  role?: string;

  @IsOptional()
  @IsIn(PLATFORM_USER_STATUSES)
  status?: (typeof PLATFORM_USER_STATUSES)[number];

  @IsOptional()
  @IsIn(PLATFORM_INVITATION_STATES)
  invitation?: (typeof PLATFORM_INVITATION_STATES)[number];
}
