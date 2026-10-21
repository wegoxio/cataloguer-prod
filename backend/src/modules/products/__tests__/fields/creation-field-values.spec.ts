import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { ProductFieldType } from '../../entities/product-field-definition.entity';

/**
 * Creation-only field values (B4a3).
 *
 * Value writes are company-wide, which would otherwise make a required field
 * impossible for a branch actor to satisfy: it could never create a product,
 * because it could never answer the field. This path exists to close that gap
 * and nothing more — it grants no authority after creation, and a branch actor
 * may only answer fields ITS OWN branch has adopted. Without that restriction,
 * creation-only authority would become a way to write arbitrary
 * organization-wide values through a product nobody asked for.
 */
describe('ProductFieldsService.writeCreationValues', () => {
  const ORG = 'org-1';
  const product = { id: 'prod-1' } as any;

  const definition = (id: string, type: ProductFieldType, over: Record<string, any> = {}) => ({
    id,
    key: id,
    type,
    archivedAt: null,
    ...over,
  });

  /**
   * `tem` records everything. `other` stands in for the injected repository's
   * manager: any call on it means the method escaped the caller's transaction.
   */
  const build = (opts: { definitions?: any[]; activeSettings?: any[] } = {}) => {
    const persisted: any[] = [];
    const calls: string[] = [];
    const created: any[] = [];

    const tem: any = {
      find: jest.fn(async (entity: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        calls.push(`find:${name}`);
        if (name === 'ProductFieldDefinition') return opts.definitions ?? [];
        if (name === 'StoreFieldSetting') return opts.activeSettings ?? [];
        return [];
      }),
      create: jest.fn((_entity: any, data: any) => {
        calls.push('create');
        const row = { ...data };
        created.push(row);
        return row;
      }),
      persist: jest.fn((row: any) => {
        calls.push('persist');
        persisted.push(row);
      }),
      flush: jest.fn(async () => {
        calls.push('flush');
      }),
    };

    const other: any = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      persist: jest.fn(),
      flush: jest.fn(),
      transactional: jest.fn(),
    };

    // The guard is a commit-path concern of setting updates; creation values
    // never touch it.
    const service = new ProductFieldsService({ getEntityManager: () => other } as any, other, {} as any);
    return { service, tem, other, persisted, created, calls };
  };

  const run = (service: ProductFieldsService, tem: any, entries: any[], actorStoreId: string | null = null) =>
    service.writeCreationValues(tem, product, ORG, entries, actorStoreId);

  it('does nothing at all for an empty payload', async () => {
    const { service, tem, calls } = build();
    await run(service, tem, []);
    expect(calls).toEqual([]);
    expect(tem.find).not.toHaveBeenCalled();
    expect(tem.flush).not.toHaveBeenCalled();
  });

  it('rejects duplicate definition ids before touching the database', async () => {
    const { service, tem, calls } = build();
    await expect(
      run(service, tem, [
        { definitionId: 'd1', value: 'a' },
        { definitionId: 'd1', value: 'b' },
      ]),
    ).rejects.toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('resolves every definition before persisting anything', async () => {
    const { service, tem, calls } = build({
      definitions: [definition('d1', ProductFieldType.TEXT), definition('d2', ProductFieldType.TEXT)],
    });
    await run(service, tem, [
      { definitionId: 'd1', value: 'x' },
      { definitionId: 'd2', value: 'y' },
    ]);
    // The lookup precedes the first create/persist, so a bad id cannot leave a
    // partially written set behind.
    expect(calls.indexOf('find:ProductFieldDefinition')).toBeLessThan(calls.indexOf('create'));
    expect(calls.indexOf('find:ProductFieldDefinition')).toBeLessThan(calls.indexOf('persist'));
  });

  it('gives a foreign or missing definition the uniform not-found', async () => {
    const { service, tem, calls } = build({ definitions: [] });
    const err = await run(service, tem, [{ definitionId: 'd-other-org', value: 'x' }]).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(calls).not.toContain('persist');
    expect(calls).not.toContain('flush');
  });

  it('gives an archived definition the established 400', async () => {
    const { service, tem } = build({
      definitions: [definition('d1', ProductFieldType.TEXT, { archivedAt: new Date() })],
    });
    const err = await run(service, tem, [{ definitionId: 'd1', value: 'x' }]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/archived/i);
  });

  describe('branch actors', () => {
    it('may answer a field their branch has adopted', async () => {
      const { service, tem, persisted } = build({
        definitions: [definition('d1', ProductFieldType.TEXT)],
        activeSettings: [{ definition: { id: 'd1' } }],
      });
      await run(service, tem, [{ definitionId: 'd1', value: 'x' }], 'store-1');
      expect(persisted).toHaveLength(1);
    });

    it('may not answer a field their branch has not adopted', async () => {
      const { service, tem, calls } = build({
        definitions: [definition('d1', ProductFieldType.TEXT)],
        activeSettings: [], // adopted by no branch of this actor
      });
      const err = await run(service, tem, [{ definitionId: 'd1', value: 'x' }], 'store-1').catch((e) => e);
      // Uniform not-found: a branch learns nothing about fields it has not adopted.
      expect(err).toBeInstanceOf(NotFoundException);
      expect(calls).not.toContain('persist');
    });

    it("queries adoption against the actor's own resolved store", async () => {
      const { service, tem } = build({
        definitions: [definition('d1', ProductFieldType.TEXT)],
        activeSettings: [{ definition: { id: 'd1' } }],
      });
      await run(service, tem, [{ definitionId: 'd1', value: 'x' }], 'store-1');
      const settingWhere = tem.find.mock.calls.find(
        (c: any[]) => (typeof c[0] === 'function' ? c[0].name : String(c[0])) === 'StoreFieldSetting',
      )[1];
      expect(settingWhere.store).toBe('store-1');
      expect(settingWhere.active).toBe(true);
    });
  });

  it('lets company-wide creation prepopulate a definition no branch has activated', async () => {
    const { service, tem, persisted } = build({
      definitions: [definition('d1', ProductFieldType.TEXT)],
      activeSettings: [],
    });
    // actorStoreId null = company-wide: no adoption check runs at all.
    await run(service, tem, [{ definitionId: 'd1', value: 'x' }], null);
    expect(persisted).toHaveLength(1);
    expect(tem.find).toHaveBeenCalledTimes(1); // definitions only, no settings query
  });

  describe('type handling reuses the existing writer', () => {
    it('trims a TEXT value', async () => {
      const { service, tem, created } = build({ definitions: [definition('d1', ProductFieldType.TEXT)] });
      await run(service, tem, [{ definitionId: 'd1', value: '  hello  ' }]);
      expect(created[0].valueText).toBe('hello');
      expect(created[0].valueNumber).toBeNull();
      expect(created[0].valueBoolean).toBeNull();
    });

    it('canonicalizes a NUMBER rather than copying it through', async () => {
      const { service, tem, created } = build({ definitions: [definition('d1', ProductFieldType.NUMBER)] });
      // Leading zeros and trailing fraction zeros are stripped, so a raw copy
      // could not produce this — which is what proves canonicalizeDecimal ran.
      await run(service, tem, [{ definitionId: 'd1', value: '0001.500' }]);
      expect(created[0].valueNumber).toBe('1.5');
      expect(created[0].valueText).toBeNull();
      expect(created[0].valueBoolean).toBeNull();
    });

    it('folds negative zero, as the shared canonicalizer does', async () => {
      const { service, tem, created } = build({ definitions: [definition('d1', ProductFieldType.NUMBER)] });
      await run(service, tem, [{ definitionId: 'd1', value: '-0.0' }]);
      expect(created[0].valueNumber).toBe('0');
    });

    it('inherits the NUMBER refusals: exponent notation and a JS number', async () => {
      const exponent = build({ definitions: [definition('d1', ProductFieldType.NUMBER)] });
      await expect(run(exponent.service, exponent.tem, [{ definitionId: 'd1', value: '1e3' }])).rejects.toThrow(
        BadRequestException,
      );

      const notAString = build({ definitions: [definition('d1', ProductFieldType.NUMBER)] });
      await expect(run(notAString.service, notAString.tem, [{ definitionId: 'd1', value: 1.5 }])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('stores a BOOLEAN and refuses its string spelling', async () => {
      const { service, tem, created } = build({ definitions: [definition('d1', ProductFieldType.BOOLEAN)] });
      await run(service, tem, [{ definitionId: 'd1', value: false }]);
      expect(created[0].valueBoolean).toBe(false);

      const second = build({ definitions: [definition('d1', ProductFieldType.BOOLEAN)] });
      await expect(run(second.service, second.tem, [{ definitionId: 'd1', value: 'true' }])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an empty TEXT value', async () => {
      const { service, tem } = build({ definitions: [definition('d1', ProductFieldType.TEXT)] });
      await expect(run(service, tem, [{ definitionId: 'd1', value: '   ' }])).rejects.toThrow(BadRequestException);
    });
  });

  it('does not flush when a LATER entry is invalid', async () => {
    const { service, tem, calls } = build({
      definitions: [definition('d1', ProductFieldType.TEXT), definition('d2', ProductFieldType.BOOLEAN)],
    });
    await expect(
      run(service, tem, [
        { definitionId: 'd1', value: 'fine' },
        { definitionId: 'd2', value: 'not-a-boolean' },
      ]),
    ).rejects.toThrow(BadRequestException);
    // The first row was staged, but nothing was flushed — the caller's
    // transaction rolls the whole creation back.
    expect(calls).not.toContain('flush');
  });

  it('gives each written row its product, organization, definition and type', async () => {
    const { service, tem, created } = build({ definitions: [definition('d1', ProductFieldType.TEXT)] });
    await run(service, tem, [{ definitionId: 'd1', value: 'x' }]);
    expect(created[0]).toMatchObject({
      organization: ORG,
      product,
      definition: expect.objectContaining({ id: 'd1' }),
      definitionType: ProductFieldType.TEXT,
    });
  });

  it('uses ONLY the supplied transactional manager', async () => {
    const { service, tem, other } = build({ definitions: [definition('d1', ProductFieldType.TEXT)] });
    await run(service, tem, [{ definitionId: 'd1', value: 'x' }]);

    // The injected repository's manager is the root one; a single call through
    // it would mean these writes escaped the creation transaction.
    for (const fn of [other.find, other.findOne, other.create, other.persist, other.flush, other.transactional]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(tem.flush).toHaveBeenCalledTimes(1);
  });
});
