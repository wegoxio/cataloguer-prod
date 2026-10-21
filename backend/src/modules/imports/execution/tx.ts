import { EntityManager } from '@mikro-orm/postgresql';

/**
 * Raw SQL that actually joins the transaction it looks like it is in.
 *
 * `em.getConnection().execute(sql, params)` does **not** participate in the
 * transaction `em.transactional()` opened. It takes a connection from the pool
 * and autocommits, whether the em it came from is the outer one or the forked
 * one the transactional callback receives. The transaction context has to be
 * passed explicitly as the fourth argument, and until this helper existed
 * nothing in the import write path passed it.
 *
 * The consequence was not theoretical: a batch that failed half way left its
 * earlier products, categories, store listings and inventory postings in the
 * catalogue while the report said every row of that batch had failed. The
 * checkpoint insert had the same defect, so `BatchAlreadyCommittedError` — the
 * mechanism that makes a mis-timed lease steal safe — did not actually undo the
 * losing worker's writes.
 *
 * Every raw statement in the import execution path goes through here. Outside a
 * transaction `getTransactionContext()` returns undefined and the behaviour is
 * exactly what it was, so this is safe on the read and setup paths too.
 */
export function txExecute<T = unknown>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params, 'all', em.getTransactionContext()) as Promise<T>;
}

/**
 * Assert that this em really is inside a transaction.
 *
 * Used at the top of the batch write path. The whole atomicity guarantee rests
 * on the appliers having been handed the forked entity manager rather than the
 * root one, and that is an easy thing to get wrong again later while every test
 * still passes — the writes would simply autocommit, exactly as they did
 * before. Failing loudly here is cheaper than discovering it from a partially
 * imported catalogue.
 */
export function assertInTransaction(em: EntityManager, what: string): void {
  if (!em.getTransactionContext()) {
    throw new Error(`${what} must run inside a transaction, but the entity manager it was given has none.`);
  }
}
