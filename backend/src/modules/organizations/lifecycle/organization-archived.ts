import { UnauthorizedException } from '@nestjs/common';

/**
 * The organization's lifecycle, as the AUTHENTICATION boundary reads it.
 *
 * Three states make a company operationally inactive: ARCHIVED (#277 P2),
 * MERGED into another (#289 P1) and REMOVED (#294 P3). Every entry point
 * that mints or honours a credential — login, refresh, the JWT guard, the MFA
 * second step, reset and invitation redemption, credential issuance — refuses
 * a member of an inactive company with ONE non-disclosing sentence, the same
 * for all three states (owner decision 11): a person signing in is not owed
 * the difference between "archived" and "removed".
 *
 * WHERE THE LIFECYCLE IS READ FROM matters more than the predicate. A removed
 * company is hidden by the ORM's default-on filter, so the populated relation
 * `user.organization` resolves to NULL for its members — and null used to
 * mean "no company, nothing to refuse". That is exactly the wrong reading: it
 * would let a removed company's manager through as a company-less account.
 * So the boundary reads the lifecycle from the member's STORED
 * `organization_id` (or, for a branch role, the branch's) with a raw
 * statement that sees every state (`readMemberOrganizationLifecycle`), and the
 * populated-relation helpers below survive only as the fast in-memory check
 * for the archived stamp on an already loaded, visible company.
 */
export function organizationIsArchived(user: {
  organization?: { archivedAt?: Date | null } | string | null;
  store?: { organization?: { archivedAt?: Date | null } | string | null } | null;
}): boolean {
  const own = user.organization;
  if (own && typeof own === 'object' && own.archivedAt) return true;
  const viaStore = user.store?.organization;
  if (viaStore && typeof viaStore === 'object' && viaStore.archivedAt) return true;
  return false;
}

export const INACTIVE_ORGANIZATION_MESSAGE = 'This company is archived — contact the platform owner';

export function assertOrganizationNotArchived(user: Parameters<typeof organizationIsArchived>[0]): void {
  if (organizationIsArchived(user)) {
    throw new UnauthorizedException(INACTIVE_ORGANIZATION_MESSAGE);
  }
}

/**
 * The company a member belongs to, read from the loaded row: their own
 * organization, or their branch's. Null for a platform account — and ALSO
 * null when the company is removed and the relation was filtered away, which
 * is why callers that decide on lifecycle use the row-derived read instead.
 */
export function organizationIdOfMember(user: {
  organization?: { id?: string } | string | null;
  store?: { organization?: { id?: string } | string | null } | null;
}): string | null {
  const own = user.organization;
  if (own) return typeof own === 'string' ? own : (own.id ?? null);
  const viaStore = user.store?.organization;
  if (viaStore) return typeof viaStore === 'string' ? viaStore : (viaStore.id ?? null);
  return null;
}

export interface OrganizationLifecycle {
  archivedAt: Date | null;
  mergedIntoOrganizationId: string | null;
  /** #294: the removal stamp. Absent only on a row read by code that predates it; read as "not removed". */
  removedAt?: Date | null;
}

type Executor = { execute: (sql: string, params?: unknown[]) => Promise<unknown> };

/** The three lifecycle columns, selected under the ORM spelling so a raw row IS an `OrganizationLifecycle`. */
const LIFECYCLE_SELECT = `archived_at as "archivedAt", merged_into_organization_id as "mergedIntoOrganizationId", removed_at as "removedAt"`;

/**
 * The lifecycle read UNDER LOCK, for the transactions that decide on it: the
 * locking statement is the read (`for share`), so a concurrent archive, merge
 * or removal holding the row `FOR UPDATE` is waited for and its committed
 * stamp is what comes back. Raw on purpose: it must see a removed company.
 */
export async function readOrganizationLifecycleLocked(
  tem: Executor,
  organizationId: string,
): Promise<OrganizationLifecycle | null> {
  const rows = (await tem.execute(
    `select ${LIFECYCLE_SELECT}
       from organizations where id = ?::uuid for share /* removed_at: the lifecycle read must see a removed company */`,
    [organizationId],
  )) as OrganizationLifecycle[];
  return rows[0] ?? null;
}

/**
 * The member's company lifecycle, derived from the member's STORED binding
 * (`users.organization_id`, else the branch's `stores.organization_id`),
 * never from a populated relation. `{ member: false }` means no such live
 * member; `organization: null` means the member has no company at all (a
 * platform account). Unlocked: the request pipeline reads it on every
 * authenticated call and the archive/removal advance every member's
 * authentication generation, so the token — not this read — is what ends a
 * session that was live when the company went inactive.
 */
export async function readMemberOrganizationLifecycle(
  em: Executor,
  userId: string,
): Promise<{ member: boolean; organizationId: string | null; organization: OrganizationLifecycle | null }> {
  const rows = (await em.execute(
    `select o.id as "organizationId", o.archived_at as "archivedAt",
            o.merged_into_organization_id as "mergedIntoOrganizationId", o.removed_at as "removedAt"
       from users u
       left join stores s on s.id = u.store_id
       left join organizations o on o.id = coalesce(u.organization_id, s.organization_id)
      where u.id = ?::uuid
        and u.removed_at is null /* removed_at: the member must be live; the COMPANY is read in every state, on purpose */`,
    [userId],
  )) as (OrganizationLifecycle & { organizationId: string | null })[];
  const row = rows[0];
  if (!row) return { member: false, organizationId: null, organization: null };
  const { organizationId, ...lifecycle } = row;
  return { member: true, organizationId, organization: organizationId ? lifecycle : null };
}

/** Archived, merged or removed — or gone entirely. */
export function organizationIsInactive(lifecycle: OrganizationLifecycle | null): boolean {
  return (
    !lifecycle ||
    lifecycle.archivedAt !== null ||
    lifecycle.mergedIntoOrganizationId !== null ||
    (lifecycle.removedAt ?? null) !== null
  );
}

/**
 * The authentication boundary's refusal, decided from the row-derived read.
 * A member with a stored company whose row is inactive — or missing — is
 * refused with the one non-disclosing sentence; a platform account (no stored
 * company) passes.
 */
export async function assertMemberOrganizationActive(em: Executor, userId: string): Promise<void> {
  const read = await readMemberOrganizationLifecycle(em, userId);
  if (!read.member) throw new UnauthorizedException('User not found');
  if (read.organizationId === null) return;
  if (organizationIsInactive(read.organization)) {
    throw new UnauthorizedException(INACTIVE_ORGANIZATION_MESSAGE);
  }
}
