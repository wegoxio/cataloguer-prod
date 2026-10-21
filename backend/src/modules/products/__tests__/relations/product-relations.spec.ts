import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductRelationsService } from '../../relations/product-relations.service';
import { ProductRelationType } from '../../entities/product-relation.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Product relations (Phase 3): directed edges, opt-in reciprocity written in
 * one transaction, and convergence rather than failure when two identical
 * requests race.
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const SOURCE = '00000000-0000-4000-8000-0000000000s0';
const TARGET = '00000000-0000-4000-8000-0000000000t0';

const orgWide: TenantScope = {
  platform: false,
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: [],
  role: 'ORGANIZATION_MANAGER',
};
const storeBound: TenantScope = {
  ...orgWide,
  storeId: '00000000-0000-4000-8000-0000000000b1',
  allowedStoreIds: ['00000000-0000-4000-8000-0000000000b1'],
  role: 'ADMIN',
};

const uniqueViolation = () => Object.assign(new Error('duplicate key'), { code: '23505' });

function build(handlers: Record<string, any> = {}) {
  const created: any[] = [];
  const removed: any[] = [];
  const tem: any = {
    findOne: jest.fn(async (entity: any, where: any) => {
      const fn = handlers[`tfindOne:${entity?.name ?? entity}`];
      return fn ? fn(where) : null;
    }),
    create: jest.fn((_entity: any, data: any) => {
      const row = { id: `rel-${created.length + 1}`, ...data };
      created.push(row);
      return row;
    }),
    persistAndFlush: jest.fn(async (row: any) => {
      if (handlers['onPersist']) await handlers['onPersist'](row);
    }),
    remove: jest.fn((row: any) => removed.push(row)),
    flush: jest.fn(),
  };
  const em: any = {
    findOne: jest.fn(async (entity: any, where: any) => {
      const fn = handlers[`findOne:${entity?.name ?? entity}`];
      return fn ? fn(where) : null;
    }),
    count: jest.fn(async () => (handlers['count'] ? handlers['count']() : 0)),
    flush: jest.fn(),
    transactional: jest.fn(async (cb: any) => cb(tem)),
  };
  const repo: any = {
    find: jest.fn(async () => (handlers['find'] ? handlers['find']() : [])),
    findOne: jest.fn(async (where: any) => (handlers['findOneRel'] ? handlers['findOneRel'](where) : null)),
  };
  const service = new ProductRelationsService(repo, em);
  return { service, em, tem, repo, created, removed };
}

const product = (id: string) => ({ id, name: `p-${id}`, slug: `s-${id}` });

describe('authority and tenancy', () => {
  it('refuses writes from a branch-bound admin', async () => {
    const { service } = build({ 'findOne:Product': () => product(SOURCE) });
    await expect(
      service.create(storeBound, SOURCE, { targetProductId: TARGET, type: ProductRelationType.RELATED } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a self-link with its own code', async () => {
    const { service } = build({ 'findOne:Product': () => product(SOURCE) });
    const error = await service
      .create(orgWide, SOURCE, { targetProductId: SOURCE, type: ProductRelationType.RELATED } as any)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'RELATION_SELF_LINK' });
  });

  it("treats another company's target as non-existent, never as forbidden", async () => {
    const { service } = build({
      'findOne:Product': (where: any) => {
        if (where.id === SOURCE) return product(SOURCE);
        // A foreign product never matches the organization filter.
        return where.organization === OTHER_ORG ? product(TARGET) : null;
      },
    });
    await expect(
      service.create(orgWide, SOURCE, { targetProductId: TARGET, type: ProductRelationType.RELATED } as any),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('reciprocity', () => {
  it('writes both edges inside ONE transaction when asked', async () => {
    const { service, em, created } = build({ 'findOne:Product': (w: any) => product(w.id) });
    const result = await service.create(orgWide, SOURCE, {
      targetProductId: TARGET,
      type: ProductRelationType.ACCESSORY,
      reciprocal: true,
    } as any);
    expect(em.transactional).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ sourceProduct: SOURCE, targetProduct: TARGET });
    expect(created[1]).toMatchObject({ sourceProduct: TARGET, targetProduct: SOURCE });
    expect(result.reciprocalRelationId).toBe('rel-2');
  });

  it('creates only the forward edge when reciprocity is not requested', async () => {
    const { service, created } = build({ 'findOne:Product': (w: any) => product(w.id) });
    const result = await service.create(orgWide, SOURCE, {
      targetProductId: TARGET,
      type: ProductRelationType.SIMILAR,
    } as any);
    expect(created).toHaveLength(1);
    expect(result.reciprocalRelationId).toBeNull();
  });

  it('rolls back the whole pair when the mirror edge fails', async () => {
    // The forward insert succeeds, the mirror throws something that is NOT a
    // unique violation: the transaction must surface it, leaving no orphan.
    let inserts = 0;
    const { service, em } = build({
      'findOne:Product': (w: any) => product(w.id),
      onPersist: async () => {
        inserts += 1;
        if (inserts === 2) throw new Error('connection lost');
      },
    });
    await expect(
      service.create(orgWide, SOURCE, {
        targetProductId: TARGET,
        type: ProductRelationType.RELATED,
        reciprocal: true,
      } as any),
    ).rejects.toThrow('connection lost');
    // One transaction was opened; its failure is what rolls both inserts back.
    expect(em.transactional).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent duplicates converge', () => {
  it('returns the winning row when a racing request inserted the same edge', async () => {
    const winner = { id: 'rel-winner', sourceProduct: SOURCE, targetProduct: TARGET, type: 'RELATED', sortOrder: 0 };
    let seen = 0;
    const { service, created } = build({
      'findOne:Product': (w: any) => product(w.id),
      // The pre-insert lookup finds nothing; after the unique violation the
      // re-read finds the row the concurrent request committed.
      'tfindOne:ProductRelation': () => (seen++ === 0 ? null : winner),
      onPersist: async () => {
        throw uniqueViolation();
      },
    });
    const result = await service.create(orgWide, SOURCE, {
      targetProductId: TARGET,
      type: ProductRelationType.RELATED,
    } as any);
    expect(result.id).toBe('rel-winner');
    expect(created).toHaveLength(1); // attempted, then discarded for the winner
  });

  it('re-raises any error that is not a unique violation', async () => {
    const { service } = build({
      'findOne:Product': (w: any) => product(w.id),
      onPersist: async () => {
        throw Object.assign(new Error('not null violation'), { code: '23502' });
      },
    });
    await expect(
      service.create(orgWide, SOURCE, { targetProductId: TARGET, type: ProductRelationType.RELATED } as any),
    ).rejects.toThrow('not null violation');
  });

  it('returns the existing edge when the same request is simply repeated', async () => {
    const existing = {
      id: 'rel-existing',
      sourceProduct: SOURCE,
      targetProduct: TARGET,
      type: 'RELATED',
      sortOrder: 0,
    };
    const { service, created } = build({
      'findOne:Product': (w: any) => product(w.id),
      'tfindOne:ProductRelation': () => existing,
    });
    const result = await service.create(orgWide, SOURCE, {
      targetProductId: TARGET,
      type: ProductRelationType.RELATED,
    } as any);
    expect(result.id).toBe('rel-existing');
    expect(created).toHaveLength(0);
  });
});

describe('deletion', () => {
  it('removes only the addressed edge and reports the surviving mirror', async () => {
    const mirror = { id: 'rel-mirror' };
    const { service, removed } = build({
      'findOne:Product': () => product(SOURCE),
      findOneRel: () => ({ id: 'rel-1', targetProduct: { id: TARGET }, type: 'RELATED' }),
      'tfindOne:ProductRelation': (where: any) => (where.sourceProduct === TARGET ? mirror : { id: 'rel-1' }),
    });
    const result = await service.remove(orgWide, SOURCE, 'rel-1', {});
    expect(removed).toHaveLength(1);
    expect(result).toMatchObject({ removedReciprocal: false, remainingReciprocalRelationId: 'rel-mirror' });
  });

  it('removes both when the caller explicitly includes the mirror', async () => {
    const mirror = { id: 'rel-mirror' };
    const { service, removed } = build({
      'findOne:Product': () => product(SOURCE),
      findOneRel: () => ({ id: 'rel-1', targetProduct: { id: TARGET }, type: 'RELATED' }),
      'tfindOne:ProductRelation': (where: any) => (where.sourceProduct === TARGET ? mirror : { id: 'rel-1' }),
    });
    const result = await service.remove(orgWide, SOURCE, 'rel-1', { includeReciprocal: true });
    expect(removed).toHaveLength(2);
    expect(result).toMatchObject({ removedReciprocal: true, remainingReciprocalRelationId: null });
  });
});
