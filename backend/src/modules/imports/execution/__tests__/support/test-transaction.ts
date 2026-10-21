import { EntityManager } from '@mikro-orm/postgresql';

/** Minimal transactional EntityManager double for executor unit tests. */
export function fakeTransactionalEm(): EntityManager {
  return {
    getTransactionContext: () => FAKE_CONTEXT,
    getConnection: () => {
      throw new Error('The fake transactional manager cannot run SQL. Use a disposable PostgreSQL test instead.');
    },
  } as unknown as EntityManager;
}

const FAKE_CONTEXT = Symbol('fake-transaction-context');
