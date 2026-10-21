import { BadRequestException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * ABSENT AND FALSE ARE DIFFERENT REQUESTS (`dto.flag ?? setting?.flag ?? false`).
 *
 * `required-setting-guard.spec.ts` pins one half of that expression: an omitted
 * flag preserves what the row already holds. This file pins the MIRROR half,
 * which nothing covered — that an explicit `false` actively turns a flag OFF.
 *
 * The two halves only mean something together. A normalization that read
 * `dto.flag || setting?.flag` would still pass the preservation test and would
 * silently ignore every deactivation, so each flag is exercised both ways from
 * the same starting row: sent as false it flips, omitted it stays. All five
 * flags are covered, because the coalescing is written out five times and a
 * single one of them could drift.
 *
 * The service and the publication guard are REAL; only the database is faked.
 */
describe('store field settings: an explicit false is a deactivation, not an omission', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a';
  const STORE = '00000000-0000-4000-8000-0000000000a1';
  const DEF = '00000000-0000-4000-8000-0000000000d1';

  const scope: TenantScope = {
    platform: false,
    organizationId: ORG,
    storeId: null,
    allowedStoreIds: [STORE],
    role: 'ORGANIZATION_MANAGER',
  };

  interface Setting {
    active: boolean;
    required: boolean;
    publiclyVisible: boolean;
    importable: boolean;
    filterable: boolean;
    sortOrder: number | null;
  }

  /** Every flag on. The starting row a deactivation has something to turn off. */
  const ALL_ON: Setting = {
    active: true,
    required: true,
    publiclyVisible: true,
    importable: true,
    filterable: true,
    sortOrder: 3,
  };

  const build = (setting: Setting | null) => {
    const persisted: any[] = [];
    let flushes = 0;

    const tem: any = {
      findOne: jest.fn(async (entity: any, where: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        if (name === 'ProductFieldDefinition') {
          return where?.id === DEF
            ? { id: DEF, key: 'weight', label: 'Weight', type: 'NUMBER', unit: 'kg', sortOrder: 0, archivedAt: null }
            : null;
        }
        if (name === 'Store') return where?.id === STORE ? { id: STORE, organization: { id: ORG } } : null;
        if (name === 'StoreFieldSetting') return setting;
        return null;
      }),
      // The store shows nothing, so any requirement scan passes vacuously and
      // the flags are the only thing under test.
      find: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn((row: any) => persisted.push(row)),
      flush: jest.fn(async () => {
        flushes += 1;
      }),
      execute: jest.fn(async () => []),
    };

    const em: any = {
      findOne: jest.fn(async (_entity: any, where: any) =>
        where?.id === STORE ? { id: STORE, organization: { id: ORG } } : null,
      ),
      transactional: jest.fn(async (cb: any) => cb(tem)),
    };

    const service = new ProductFieldsService({ find: jest.fn() } as any, em, new PublicationGuardService());
    return {
      service,
      persisted,
      flushed: () => flushes,
      upsert: (dto: any) => service.upsertStoreSetting(scope, STORE, DEF, dto),
    };
  };

  /** The four flags a deactivation may turn off on their own. */
  const DEPENDENT = ['required', 'publiclyVisible', 'importable', 'filterable'] as const;

  describe.each(DEPENDENT)('%s', (flag) => {
    it('is turned OFF when it is sent as false', async () => {
      const world = build({ ...ALL_ON });

      const out = await world.upsert({ [flag]: false });

      expect(out.setting).toMatchObject({ ...ALL_ON, [flag]: false });
      // The row was actually written, not merely returned.
      expect(world.persisted).toHaveLength(1);
      expect(world.flushed()).toBe(1);
    });

    it('stays ON when it is omitted from the very same request', async () => {
      const world = build({ ...ALL_ON });

      const out = await world.upsert({});

      expect(out.setting).toMatchObject(ALL_ON);
    });
  });

  it('turns active off, once the request also turns off everything that depends on it', async () => {
    // `active` cannot be dropped alone while a dependent flag remains set, so
    // its deactivation is stated in full — and every flag lands false.
    const world = build({ ...ALL_ON });

    const out = await world.upsert({
      active: false,
      required: false,
      publiclyVisible: false,
      importable: false,
      filterable: false,
    });

    expect(out.setting).toMatchObject({
      active: false,
      required: false,
      publiclyVisible: false,
      importable: false,
      filterable: false,
      sortOrder: 3,
    });
    expect(world.persisted).toHaveLength(1);
  });

  it('turns active off on its own when nothing depends on it', async () => {
    const world = build({ ...ALL_ON, required: false, publiclyVisible: false, importable: false, filterable: false });

    const out = await world.upsert({ active: false });

    expect(out.setting).toMatchObject({ active: false, sortOrder: 3 });
  });

  it('keeps active ON when it is omitted, so a label change never closes the field', async () => {
    const world = build({ ...ALL_ON, required: false, publiclyVisible: false, importable: false, filterable: false });

    const out = await world.upsert({ sortOrder: 7 });

    expect(out.setting).toMatchObject({ active: true, sortOrder: 7 });
  });

  it('refuses the half-stated deactivation instead of choosing for the caller', async () => {
    // The refusal is what makes the explicit-false contract safe: dropping
    // `active` while the dependents stay set would either publish through an
    // inactive field or silently clear flags the caller never mentioned.
    const world = build({ ...ALL_ON });

    await expect(world.upsert({ active: false })).rejects.toThrow(BadRequestException);
    expect(world.persisted).toHaveLength(0);
  });

  it('reads a missing row as every flag false, so a first write states what it wants', async () => {
    const world = build(null);

    const out = await world.upsert({ publiclyVisible: false });

    expect(out.setting).toMatchObject({
      active: false,
      required: false,
      publiclyVisible: false,
      importable: false,
      filterable: false,
    });
  });
});
