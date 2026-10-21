import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { isUniqueViolationOn } from './unique-violation';

const NAMES = ['idx_a', 'idx_b'];

describe('isUniqueViolationOn', () => {
  it('matches a 23505 with a top-level constraint in the list', () => {
    expect(isUniqueViolationOn({ code: '23505', constraint: 'idx_a' }, NAMES)).toBe(true);
  });

  it('matches a 23505 reported on driverError.constraint', () => {
    expect(isUniqueViolationOn({ driverError: { code: '23505', constraint: 'idx_b' } }, NAMES)).toBe(true);
  });

  it('matches a MikroORM UniqueConstraintViolationException carrying the name', () => {
    const e = new UniqueConstraintViolationException(new Error('dup'));
    (e as any).constraint = 'idx_a';
    expect(isUniqueViolationOn(e, NAMES)).toBe(true);
  });

  it('matches by name flag when instanceof is unavailable (wrapped/serialised)', () => {
    expect(isUniqueViolationOn({ name: 'UniqueConstraintViolationException', constraint: 'idx_b' }, NAMES)).toBe(true);
  });

  it('rejects a 23505 whose constraint is NOT in the list', () => {
    expect(isUniqueViolationOn({ code: '23505', constraint: 'some_other_uniq' }, NAMES)).toBe(false);
  });

  it('rejects a non-unique error (e.g. FK 23503) even with a listed constraint name', () => {
    expect(isUniqueViolationOn({ code: '23503', constraint: 'idx_a' }, NAMES)).toBe(false);
  });

  it('rejects a unique violation that carries no constraint name', () => {
    expect(isUniqueViolationOn({ code: '23505' }, NAMES)).toBe(false);
  });

  it('rejects null / non-object inputs', () => {
    expect(isUniqueViolationOn(null, NAMES)).toBe(false);
    expect(isUniqueViolationOn('boom', NAMES)).toBe(false);
  });
});
