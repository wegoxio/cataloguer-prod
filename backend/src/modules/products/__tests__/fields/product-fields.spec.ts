import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldType } from '../../entities/product-field-definition.entity';
import { canonicalizeDecimal, normalizeFieldKey } from '../../fields/product-field.util';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * B4a2: field definitions, store activation and product-owned values.
 *
 * The load-bearing rule tested here is authority, not storage: a value row is
 * read by EVERY branch showing the product, so seeing that product in your own
 * branch does not entitle you to change what a sibling branch reads.
 */

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const STORE_A1 = '00000000-0000-4000-8000-0000000000a1';
const STORE_A2 = '00000000-0000-4000-8000-0000000000a2';
const PRODUCT = '00000000-0000-4000-8000-0000000000p1'.replace(/[^0-9a-f-]/g, '0');
const DEF = '00000000-0000-4000-8000-0000000000d1';

const scopeOf = (o: Partial<TenantScope>): TenantScope => ({
  platform: false,
  organizationId: null,
  storeId: null,
  allowedStoreIds: [],
  role: 'ADMIN',
  ...o,
});

// Company-wide: a manager not narrowed to one branch.
const orgWide = scopeOf({ organizationId: ORG_A, allowedStoreIds: [STORE_A1, STORE_A2], role: 'ORGANIZATION_MANAGER' });
// Branch-bound: a store admin pinned to its own branch.
const branch = scopeOf({ organizationId: ORG_A, storeId: STORE_A1, allowedStoreIds: [STORE_A1] });
// Platform owner acting inside a company: company-wide, exactly like a manager.
const managedPlatform = scopeOf({
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: ORG_A,
  allowedStoreIds: [STORE_A1, STORE_A2],
});
// Platform owner narrowed to one branch: no longer company-wide.
const managedPlatformInStore = scopeOf({
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: ORG_A,
  storeId: STORE_A1,
  allowedStoreIds: [STORE_A1],
});
// Unscoped owner: no company in context at all.
const unscopedPlatform = scopeOf({ platform: true, role: 'SUPER_ADMIN' });
// Role string claims platform, resolved scope says otherwise (#176 lesson).
const malformedPlatform = scopeOf({
  role: 'SUPER_ADMIN',
  organizationId: ORG_A,
  storeId: STORE_A1,
  allowedStoreIds: [STORE_A1],
});

const definitionRow = (over: Record<string, any> = {}) => ({
  id: DEF,
  organization: { id: ORG_A },
  key: 'color',
  label: 'Color',
  type: ProductFieldType.TEXT,
  unit: null as string | null,
  sortOrder: 0,
  archivedAt: null as Date | null,
  ...over,
});

function serviceWith(handlers: Record<string, any> = {}) {
  const created: any[] = [];
  const tem = {
    findOne: jest.fn(async (entity: any, where: any) => {
      const name = entity?.name ?? String(entity);
      const fn = handlers[`findOne:${name}`];
      return fn ? fn(where) : null;
    }),
    find: jest.fn(async (entity: any, where: any) => {
      const name = entity?.name ?? String(entity);
      const fn = handlers[`find:${name}`];
      return fn ? fn(where) : [];
    }),
    count: jest.fn(async (entity: any, where: any) => {
      const name = entity?.name ?? String(entity);
      const fn = handlers[`count:${name}`];
      return fn ? fn(where) : 0;
    }),
    create: jest.fn((_e: any, data: any) => {
      const row = { ...data };
      created.push(row);
      return row;
    }),
    persist: jest.fn(),
    persistAndFlush: jest.fn(),
    flush: jest.fn(),
    // upsertStoreSetting holds the store's publication lock (B4a3).
    execute: jest.fn(async () => []),
  };
  const em: any = { ...tem, transactional: jest.fn(async (cb: any) => cb(tem)) };
  const definitionRepository = {
    find: jest.fn(async (where: any) => (handlers['find:ProductFieldDefinition'] ?? (() => []))(where)),
  };
  const service = new ProductFieldsService(definitionRepository as any, em as any, new PublicationGuardService());
  return { service, em, tem, created, definitionRepository };
}

describe('normalizeFieldKey', () => {
  it('derives a stable ASCII key, folding accents rather than splitting identity', () => {
    expect(normalizeFieldKey('Color')).toBe('color');
    expect(normalizeFieldKey('  Shoe   Size ')).toBe('shoe-size');
    expect(normalizeFieldKey('Café Size')).toBe('cafe-size');
    expect(normalizeFieldKey('Café Size')).toBe(normalizeFieldKey('Cafe Size'));
    expect(normalizeFieldKey('weight_kg')).toBe('weight-kg');
    expect(normalizeFieldKey('--Odd--Spacing--')).toBe('odd-spacing');
  });

  it('refuses input with no ASCII form instead of inventing a key', () => {
    // A field key is permanent, so guessing it once is a mistake forever.
    expect(() => normalizeFieldKey('色')).toThrow(BadRequestException);
    expect(() => normalizeFieldKey('   ')).toThrow(BadRequestException);
    expect(() => normalizeFieldKey('!!!')).toThrow(BadRequestException);
  });
});

describe('canonicalizeDecimal', () => {
  it('accepts plain decimals and canonicalizes without changing the value', () => {
    expect(canonicalizeDecimal('12')).toBe('12');
    expect(canonicalizeDecimal('007.5000')).toBe('7.5');
    expect(canonicalizeDecimal('-3.250000')).toBe('-3.25');
    expect(canonicalizeDecimal('-0.000000')).toBe('0');
    expect(canonicalizeDecimal('  42.125  ')).toBe('42.125');
    // The full numeric(18,6) range, which a double cannot hold exactly.
    expect(canonicalizeDecimal('123456789012.123456')).toBe('123456789012.123456');
  });

  it('refuses exponents, over-scale, over-precision and non-strings', () => {
    expect(() => canonicalizeDecimal('1e3')).toThrow(BadRequestException);
    expect(() => canonicalizeDecimal('1.0000001')).toThrow(BadRequestException); // 7 decimals
    expect(() => canonicalizeDecimal('1234567890123')).toThrow(BadRequestException); // 13 integer digits
    expect(() => canonicalizeDecimal('abc')).toThrow(BadRequestException);
    expect(() => canonicalizeDecimal('')).toThrow(BadRequestException);
    expect(() => canonicalizeDecimal(12 as any)).toThrow(BadRequestException);
    expect(() => canonicalizeDecimal(null as any)).toThrow(BadRequestException);
  });
});

describe('ProductFieldsService — organization context', () => {
  it('400s an unscoped platform owner: "which company?" is malformed, not hidden', async () => {
    const { service } = serviceWith();
    await expect(service.listDefinitions(unscopedPlatform)).rejects.toThrow(BadRequestException);
    await expect(service.listValues(unscopedPlatform, PRODUCT)).rejects.toThrow(BadRequestException);
  });

  it('treats a platform owner inside a company as tenant-scoped, by scope not role', async () => {
    const { service } = serviceWith({ 'find:ProductFieldDefinition': () => [definitionRow()] });
    const rows = await service.listDefinitions(managedPlatform);
    expect(rows.map((r) => r.key)).toEqual(['color']);
  });
});

describe('ProductFieldsService — definitions', () => {
  it('creates with a derived key and refuses a duplicate, including an archived one', async () => {
    const { service } = serviceWith({ 'findOne:ProductFieldDefinition': () => null });
    const made = await service.createDefinition(orgWide, { label: 'Café Size', type: ProductFieldType.TEXT } as any);
    expect(made.key).toBe('cafe-size');

    const withArchivedClash = serviceWith({
      'findOne:ProductFieldDefinition': () => definitionRow({ key: 'cafe-size', archivedAt: new Date() }),
    });
    await expect(
      withArchivedClash.service.createDefinition(orgWide, { label: 'Café Size', type: ProductFieldType.TEXT } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('allows a unit only on NUMBER, and clears it with an explicit null', async () => {
    const { service } = serviceWith({ 'findOne:ProductFieldDefinition': () => null });
    await expect(
      service.createDefinition(orgWide, { label: 'Shade', type: ProductFieldType.TEXT, unit: 'cm' } as any),
    ).rejects.toThrow(BadRequestException);

    const row = definitionRow({ type: ProductFieldType.NUMBER, unit: 'cm' });
    const upd = serviceWith({ 'findOne:ProductFieldDefinition': () => row });
    // Omission preserves...
    await upd.service.updateDefinition(orgWide, DEF, { label: 'Width' } as any);
    expect(row.unit).toBe('cm');
    // ...an explicit null clears.
    await upd.service.updateDefinition(orgWide, DEF, { unit: null } as any);
    expect(row.unit).toBeNull();
  });

  it('404s a definition belonging to another company', async () => {
    const { service } = serviceWith({ 'findOne:ProductFieldDefinition': () => null });
    await expect(
      service.updateDefinition(scopeOf({ organizationId: ORG_B }), DEF, { label: 'X' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to archive while a store still has it active, and restores without reactivating', async () => {
    const row = definitionRow();
    const busy = serviceWith({
      'findOne:ProductFieldDefinition': () => row,
      'count:StoreFieldSetting': () => 2,
    });
    await expect(busy.service.archiveDefinition(orgWide, DEF)).rejects.toThrow(BadRequestException);
    expect(row.archivedAt).toBeNull();

    const free = serviceWith({ 'findOne:ProductFieldDefinition': () => row, 'count:StoreFieldSetting': () => 0 });
    const archived = await free.service.archiveDefinition(orgWide, DEF);
    expect(archived.archivedAt).not.toBeNull();

    const restored = await free.service.restoreDefinition(orgWide, DEF);
    expect(restored.archivedAt).toBeNull();
  });
});

describe('ProductFieldsService — store settings', () => {
  const store = { id: STORE_A1, organization: { id: ORG_A } };

  it('404s a sibling store the actor is not allowed to touch', async () => {
    const { service } = serviceWith({ 'findOne:Store': () => ({ id: STORE_A2, organization: { id: ORG_A } }) });
    await expect(service.listStoreSettings(branch, STORE_A2)).rejects.toThrow(NotFoundException);
  });

  it('lists every live definition, with null where the branch never activated one', async () => {
    const { service } = serviceWith({
      'findOne:Store': () => store,
      'find:ProductFieldDefinition': () => [definitionRow(), definitionRow({ id: 'd2', key: 'size', label: 'Size' })],
      'find:StoreFieldSetting': () => [
        {
          definition: { id: DEF },
          active: true,
          required: false,
          publiclyVisible: true,
          importable: false,
          sortOrder: 1,
        },
      ],
    });
    const rows = await service.listStoreSettings(orgWide, STORE_A1);
    expect(rows.map((r) => r.definition.key)).toEqual(['color', 'size']);
    expect(rows[0].setting).toMatchObject({ active: true, publiclyVisible: true, required: false });
    expect(rows[1].setting).toBeNull();
  });

  it('refuses deactivating while public or importable remain set', async () => {
    const setting = { active: true, required: false, publiclyVisible: true, importable: false, sortOrder: null };
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => definitionRow(),
      'findOne:Store': () => store,
      'findOne:StoreFieldSetting': () => setting,
    });
    await expect(service.upsertStoreSetting(orgWide, STORE_A1, DEF, { active: false } as any)).rejects.toThrow(
      BadRequestException,
    );
    expect(setting.active).toBe(true);
  });

  it('refuses activating an archived definition', async () => {
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => definitionRow({ archivedAt: new Date() }),
      'findOne:Store': () => store,
    });
    await expect(service.upsertStoreSetting(orgWide, STORE_A1, DEF, { active: true } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('ProductFieldsService — values require company-wide authority', () => {
  const product = { id: PRODUCT, organization: { id: ORG_A } };
  const handlers = {
    'findOne:Product': () => product,
    'findOne:ProductFieldDefinition': () => definitionRow(),
    'findOne:ProductFieldValue': () => null,
  };

  it('lets a company-wide actor write a value', async () => {
    const { service, created } = serviceWith(handlers);
    const out = await service.upsertValue(orgWide, PRODUCT, DEF, { value: ' Green ' } as any);
    expect(out.value).toBe('Green');
    expect(created[0].definitionType).toBe(ProductFieldType.TEXT);
  });

  it('refuses a BRANCH actor, even for a product its own store carries', async () => {
    // Presence in one branch is not authority over what siblings read.
    const { service } = serviceWith(handlers);
    await expect(service.upsertValue(branch, PRODUCT, DEF, { value: 'Green' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses a platform owner narrowed to a single branch, and a malformed platform scope', async () => {
    const { service } = serviceWith(handlers);
    await expect(service.upsertValue(managedPlatformInStore, PRODUCT, DEF, { value: 'Green' } as any)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.upsertValue(malformedPlatform, PRODUCT, DEF, { value: 'Green' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a platform owner acting company-wide', async () => {
    const { service } = serviceWith(handlers);
    const out = await service.upsertValue(managedPlatform, PRODUCT, DEF, { value: 'Green' } as any);
    expect(out.value).toBe('Green');
  });

  it('still lets a branch actor READ values', async () => {
    const { service } = serviceWith({
      'findOne:Product': () => product,
      'find:ProductFieldValue': () => [
        { definition: definitionRow(), definitionType: ProductFieldType.TEXT, valueText: 'Green' },
      ],
    });
    const rows = await service.listValues(branch, PRODUCT);
    expect(rows).toEqual([
      { definitionId: DEF, key: 'color', label: 'Color', type: ProductFieldType.TEXT, unit: null, value: 'Green' },
    ]);
  });

  it('404s a product of another company with the same shape as a missing one', async () => {
    const { service } = serviceWith({ 'findOne:Product': () => null });
    const foreign = await service.listValues(orgWide, PRODUCT).catch((e: Error) => e.message);
    const missing = await service.listValues(orgWide, 'no-such-id').catch((e: Error) => e.message);
    expect(foreign).toBe(missing);
  });

  it('enforces the definition type, and refuses archived definitions', async () => {
    const numeric = serviceWith({
      ...handlers,
      'findOne:ProductFieldDefinition': () => definitionRow({ type: ProductFieldType.NUMBER, unit: 'cm' }),
    });
    const out = await numeric.service.upsertValue(orgWide, PRODUCT, DEF, { value: '007.5000' } as any);
    expect(out.value).toBe('7.5');
    // A JavaScript number is refused: numeric(18,6) outruns a double.
    await expect(numeric.service.upsertValue(orgWide, PRODUCT, DEF, { value: 7.5 } as any)).rejects.toThrow(
      BadRequestException,
    );

    const bool = serviceWith({
      ...handlers,
      'findOne:ProductFieldDefinition': () => definitionRow({ type: ProductFieldType.BOOLEAN }),
    });
    await expect(bool.service.upsertValue(orgWide, PRODUCT, DEF, { value: 'true' } as any)).rejects.toThrow(
      BadRequestException,
    );
    expect((await bool.service.upsertValue(orgWide, PRODUCT, DEF, { value: false } as any)).value).toBe(false);

    const text = serviceWith(handlers);
    await expect(text.service.upsertValue(orgWide, PRODUCT, DEF, { value: '   ' } as any)).rejects.toThrow(
      BadRequestException,
    );

    const archived = serviceWith({
      ...handlers,
      'findOne:ProductFieldDefinition': () => definitionRow({ archivedAt: new Date() }),
    });
    await expect(archived.service.upsertValue(orgWide, PRODUCT, DEF, { value: 'Green' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});
