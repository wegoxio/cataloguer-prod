import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/**
 * Roles this local-only endpoint may mint. SUPER_ADMIN is deliberately
 * excluded (P1-06): the first platform owner is created by the seeder, and
 * real admins are invited through the Users screen — never by this endpoint.
 */
export const REGISTER_DEV_ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

export class RegisterDevDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /**
   * The store the dev user is created in (#156). Every role this endpoint can
   * mint is branch-level, so an unscoped user would violate the binding
   * invariant and be unable to log in at all — the store is mandatory and the
   * organization is derived from it.
   */
  @IsUUID()
  storeId!: string;

  /** Defaults to EDITOR; only the whitelisted low-privilege roles are allowed. */
  @IsOptional()
  @IsIn(REGISTER_DEV_ROLES)
  role?: (typeof REGISTER_DEV_ROLES)[number];
}
