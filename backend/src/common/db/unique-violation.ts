import { UniqueConstraintViolationException } from '@mikro-orm/core';

/**
 * True only when `error` is a Postgres unique violation (SQLSTATE 23505 /
 * MikroORM's {@link UniqueConstraintViolationException}) AND the violated
 * constraint/index name is one of `constraintNames`.
 *
 * Postgres reports the violated UNIQUE index/constraint name in the driver
 * error's `constraint` field (for a `CREATE UNIQUE INDEX` it is the index
 * name). Matching on it lets a caller retry ONLY the collision it expects and
 * re-throw every unrelated unique/foreign-key violation untouched.
 */
export function isUniqueViolationOn(error: unknown, constraintNames: readonly string[]): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    code?: string;
    name?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const isUnique =
    error instanceof UniqueConstraintViolationException ||
    err.name === 'UniqueConstraintViolationException' ||
    err.code === '23505' ||
    err.driverError?.code === '23505';
  if (!isUnique) return false;
  const constraint = err.constraint ?? err.driverError?.constraint;
  return constraint != null && constraintNames.includes(constraint);
}
