import { EntityManager } from '@mikro-orm/postgresql';
import { User } from '../entities/user.entity';
import { lockOrganizationAccess, lockUsers } from './access-locks';
import {
  OrganizationLifecycle,
  organizationIdOfMember,
  organizationIsInactive,
  readOrganizationLifecycleLocked,
} from '../../organizations/lifecycle/organization-archived';

/**
 * A CREDENTIAL IS ISSUED TO THE MEMBER AS THEY ARE, NOT AS THEY WERE (#277 P2).
 *
 * Every producer of a reset or invitation token starts from a user it loaded
 * before any lock. That user is only a HINT about which company to lock: a
 * concurrent write may move the member, remove them or deactivate them while
 * issuance waits. So the algorithm is:
 *
 *   1. from the hint, choose the candidate lock set (the company);
 *   2. take `org-access` for it and read that company's lifecycle FOR SHARE;
 *   3. lock the member row;
 *   4. RELOAD the member through the transaction's entity manager and derive
 *      their company from that locked, refreshed row and nothing else;
 *   5. if the company differs from the one locked, ROLL BACK and start again
 *      with the company just observed — never continue under the wrong lock;
 *   6. validate the final company's lifecycle under lock, immediately before
 *      the write, and only then let the caller write.
 *
 * A member who is gone (removed — the default filter hides them — or
 * deactivated) yields `null`, and so does a company that is archived, merged
 * or missing. The caller decides how to say so: the reset stays silent, an
 * invitation answers.
 */
export interface IssuanceContext {
  user: User;
  organizationId: string | null;
  lifecycle: OrganizationLifecycle | null;
}

const MAX_RESTARTS = 4;

class RestartWith extends Error {
  constructor(readonly organizationId: string | null) {
    super('restart');
  }
}

export async function withMemberLockedForIssuance<T>(
  em: EntityManager,
  hint: User,
  work: (tem: EntityManager, context: IssuanceContext) => Promise<T>,
): Promise<T | null> {
  let candidate = organizationIdOfMember(hint as never);
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt += 1) {
    try {
      return await em.transactional(async (tem) => {
        let lifecycle: OrganizationLifecycle | null = null;
        if (candidate) {
          await lockOrganizationAccess(tem, candidate);
          lifecycle = await readOrganizationLifecycleLocked(tem, candidate);
        }
        await lockUsers(tem, [hint.id]);
        // THE RELOAD: the member as committed now, under the row lock.
        const current = await reloadMemberInTransaction(tem, hint.id);
        if (!current || current.deletedAt) return null;
        const organizationId = organizationIdOfMember(current as never);
        if (organizationId !== candidate) throw new RestartWith(organizationId);
        if (organizationId && organizationIsInactive(lifecycle)) return null;
        return work(tem, { user: current, organizationId, lifecycle });
      });
    } catch (error) {
      if (error instanceof RestartWith) {
        candidate = error.organizationId;
        continue;
      }
      throw error;
    }
  }
  // The membership kept moving under us; refusing is the only safe answer.
  return null;
}

/**
 * The member's row as it stands INSIDE this transaction, as a distinct object.
 *
 * Read through a cleared fork that KEEPS THE TRANSACTION CONTEXT: same
 * connection, same locks, same transaction-local view — but its own identity
 * map, so the caller's hint is not hydrated in place and what comes back is
 * the reloaded recipient and nothing else. A fork without
 * `keepTransactionContext` would open a second connection outside the
 * transaction: it would neither see this transaction's own writes nor wait on
 * its locks, and it would hold a pool connection while the locks are held.
 */
export async function reloadMemberInTransaction(tem: EntityManager, userId: string): Promise<User | null> {
  const reader = tem.fork({ clear: true, keepTransactionContext: true });
  return reader.findOne(
    User,
    { id: userId },
    { populate: ['role', 'store', 'store.organization', 'organization'] as never, refresh: true },
  );
}
