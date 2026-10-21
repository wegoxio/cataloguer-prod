import { EntityManager } from '@mikro-orm/postgresql';
import { User } from '../entities/user.entity';

/**
 * THE LOCK ORDER FOR AUTHORITY CHANGES, and why counting is not enough.
 *
 * Every safeguard in this slice is a "at least one must remain" rule: an active
 * organization keeps an active ORGANIZATION_MANAGER, the platform keeps an
 * active SUPER_ADMIN. Those rules cannot be enforced by counting after the
 * write. Two concurrent transactions each demote a different one of the last
 * two managers; each counts the rows IT can see; each sees one manager left —
 * its own not-yet-committed victim excluded, the other's demotion invisible —
 * and both commit. The organization ends with zero managers and every
 * individual transaction was, on its own evidence, correct.
 *
 * So the count has to happen while nobody else may be counting. These are
 * TRANSACTION-SCOPED advisory locks (`pg_advisory_xact_lock`), released by
 * commit or rollback with no unlock path to forget, taken in ONE documented
 * order:
 *
 *   1. `org-access:<organizationId>` .... every access change and every manager
 *      transfer inside one organization serialises here. Two organizations
 *      never block each other.
 *   2. row locks on the target users, `FOR UPDATE`, in ASCENDING ID ORDER.
 *
 * THERE IS NO PLATFORM LOCK, and its absence is a decision. No API path can
 * modify a SUPER_ADMIN — `assertCanManageRole` refuses a target at or above the
 * actor's level, and every SUPER_ADMIN is the top level — so a count-and-lock
 * guard for that population would be unreachable code that no test could
 * exercise through a real path. A deliberate Superadmin-management contract
 * will bring its own lock, acquired before any row lock.
 *
 * Ascending order is the deadlock argument, and it is why `lockUsers` sorts
 * rather than trusting its caller: a transfer touches two users, and two
 * transfers touching the same pair from opposite ends would each hold what the
 * other needs. Sorting by id gives every transaction the same sequence, so the
 * second one simply waits.
 *
 * Anything that takes both 1 and 2 must take them in that order. Nothing in
 * this codebase takes 2 before 1.
 */

/** Lock 1 — one organization's access-management critical section. */
export async function lockOrganizationAccess(em: EntityManager, organizationId: string): Promise<void> {
  await em.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`org-access:${organizationId}`]);
}

/**
 * Lock 2 — the target rows, deterministically ordered.
 *
 * Duplicates are collapsed and blanks dropped so a caller may pass the same id
 * twice (a transfer whose two sides were mistakenly the same person is refused
 * later, by a rule that can say so) without self-deadlocking here.
 */
export async function lockUsers(em: EntityManager, userIds: (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  if (ids.length === 0) return;
  // `removed_at` is deliberately NOT filtered: this lock has to reach the row
  // whatever its lifecycle state. Removal locks a live row and restoration locks
  // a removed one, and a filtered lock would silently take nothing for the
  // second — leaving restoration racing every other writer.
  await em.execute(
    `select id from users where id in (?) order by id for update /* removed_at: locks by id in any state */`,
    [ids],
  );
}

/**
 * How many active ORGANIZATION_MANAGERs this organization has, counted through
 * the transaction's own entity manager so it sees this transaction's writes.
 *
 * A REMOVED manager is not an active one. Without `removed_at is null` here,
 * removing the second-to-last manager would look safe because the already
 * removed one still counted, and the organization would be left with none.
 *
 * Only meaningful while {@link lockOrganizationAccess} is held.
 */
export async function countActiveManagers(em: EntityManager, organizationId: string): Promise<number> {
  const rows = await em.execute<{ c: string }[]>(
    `select count(*)::int as c
       from users u join roles r on r.id = u.role_id
      where u.organization_id = ? and u.deleted_at is null and u.removed_at is null
        and r.name = 'ORGANIZATION_MANAGER'`,
    [organizationId],
  );
  return Number(rows[0]?.c ?? 0);
}

/** The binding of a user as the audit trail records it — before and after. */
export interface AccessSnapshot {
  role: string;
  organizationId: string | null;
  storeId: string | null;
}

const idOf = (rel: { id?: string } | string | null | undefined): string | null => {
  if (!rel) return null;
  return typeof rel === 'string' ? rel : (rel.id ?? null);
};

/** Reads a loaded user's access as a plain record. No secrets, by construction. */
export function snapshotOf(user: Pick<User, 'role' | 'organization' | 'store'>): AccessSnapshot {
  return {
    role: user.role?.name ?? '',
    organizationId: idOf(user.organization as never),
    storeId: idOf(user.store as never),
  };
}

/** True when two snapshots describe the same access — the idempotence test. */
export function sameAccess(a: AccessSnapshot, b: AccessSnapshot): boolean {
  return a.role === b.role && a.organizationId === b.organizationId && a.storeId === b.storeId;
}
