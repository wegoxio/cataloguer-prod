import { IsIn, IsUUID, ValidateIf } from 'class-validator';

/**
 * The roles the ORGANIZATION ACCESS contract may assign, and the one it may not.
 *
 * SUPER_ADMIN is absent ON PURPOSE and its absence is load-bearing: platform
 * authority is not an organization's to grant, so it must be unreachable
 * through a route whose subject is an organization. Keeping it out of the DTO
 * means the refusal happens at validation, before any service, any lock and any
 * transaction — there is no code path where a body could nominate it.
 *
 * STORE_ADMIN is absent too, but for a different reason: it is an unused
 * compatibility alias with no route, no assignment path and the same authority
 * level as ADMIN (#278). New surfaces must not spread it.
 *
 * This is deliberately NOT the legacy `ASSIGNABLE_ROLES`, which the old
 * `PATCH /users/:id/role` still uses. That list omits ORGANIZATION_MANAGER —
 * the omission this contract exists to fix — and widening it in place would
 * have changed the legacy route's meaning as a side effect.
 */
export const ORGANIZATION_ASSIGNABLE_ROLES = ['ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;

/** The roles a former manager may be demoted INTO: branch roles only. */
export const BRANCH_ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

export class ChangeUserAccessDto {
  @IsIn(ORGANIZATION_ASSIGNABLE_ROLES)
  role!: string;

  /**
   * The branch, or `null` for organization-wide authority.
   *
   * `null` is a MEANINGFUL value here, not an omission — it is how a caller
   * says "company-wide" — so the property is validated when present and
   * required to be explicitly present. A missing `storeId` is a 400 rather than
   * a silent `null`, because "I forgot the branch" and "I mean no branch" must
   * not be the same request.
   */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  storeId!: string | null;
}

export class TransferOrganizationManagerDto {
  @IsUUID()
  currentManagerUserId!: string;

  @IsUUID()
  replacementUserId!: string;

  /**
   * What the outgoing manager becomes. A transfer is not a demotion to nowhere:
   * the former manager keeps a defined place in the organization, and naming it
   * here is what makes the whole exchange expressible as one request.
   */
  @IsIn(BRANCH_ROLES)
  formerManagerRole!: string;

  /** The branch the outgoing manager is pinned to. Required: branch roles need one. */
  @IsUUID()
  formerManagerStoreId!: string;
}
