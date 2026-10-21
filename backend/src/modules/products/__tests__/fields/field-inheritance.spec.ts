import { BadRequestException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldType } from '../../entities/product-field-definition.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Phase 2: applicability, override policy and effective-value resolution.
 *
 * The deterministic contract under test:
 *  - PARENT-only: direct values on models and standalone items; versions
 *    always refused, and they inherit for display.
 *  - CHILD-only: direct values on versions and standalone items; models
 *    refused; nothing inherits (there is nothing to inherit from).
 *  - BOTH + override allowed: model default, version may override; the
 *    version's direct value wins.
 *  - BOTH + override disabled: family members hold model values only;
 *    version writes are ALWAYS refused — never dependent on whether the
 *    model currently has a value, which could change later.
 *  - Standalone products satisfy every applicability.
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const PARENT_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const ALONE_ID = '00000000-0000-4000-8000-000000000003';
const DEF = '00000000-0000-4000-8000-0000000000d1';

const orgWide: TenantScope = {
  platform: false,
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: [],
  role: 'ORGANIZATION_MANAGER',
};

const definitionRow = (over: Record<string, any> = {}) => ({
  id: DEF,
  organization: { id: ORG },
  key: 'material',
  label: 'Material',
  type: ProductFieldType.TEXT,
  unit: null as string | null,
  source: 'CUSTOM',
  fieldGroup: null,
  applicability: 'BOTH',
  childOverrideAllowed: true,
  options: null,
  sortOrder: 0,
  archivedAt: null as Date | null,
  ...over,
});

function serviceWith(handlers: Record<string, any> = {}) {
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
    create: jest.fn((_e: any, data: any) => ({ ...data })),
    persist: jest.fn(),
    persistAndFlush: jest.fn(),
    flush: jest.fn(),
    execute: jest.fn(async (...args: any[]) => (handlers['execute'] ? handlers['execute'](...args) : [])),
  };
  const em: any = { ...tem, transactional: jest.fn(async (cb: any) => cb(tem)) };
  const definitionRepository = {
    find: jest.fn(async (where: any) => (handlers['find:ProductFieldDefinition'] ?? (() => []))(where)),
  };
  const service = new ProductFieldsService(definitionRepository as any, em as any, new PublicationGuardService());
  return { service, em, tem };
}

describe('assertDirectValueAllowed — the applicability matrix', () => {
  const service = new ProductFieldsService({} as any, {} as any, new PublicationGuardService());
  const parentPos = { hasParent: false, hasChildren: true };
  const childPos = { hasParent: true, hasChildren: false };
  const alonePos = { hasParent: false, hasChildren: false };

  it('PARENT-only: models and standalone yes, versions never', () => {
    const def = definitionRow({ applicability: 'PARENT' }) as any;
    expect(() => service.assertDirectValueAllowed(def, parentPos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, alonePos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, childPos)).toThrow(BadRequestException);
  });

  it('CHILD-only: versions and standalone yes, models never', () => {
    const def = definitionRow({ applicability: 'CHILD' }) as any;
    expect(() => service.assertDirectValueAllowed(def, childPos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, alonePos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, parentPos)).toThrow(BadRequestException);
  });

  it('BOTH + override allowed: everyone', () => {
    const def = definitionRow({ applicability: 'BOTH', childOverrideAllowed: true }) as any;
    for (const pos of [parentPos, childPos, alonePos]) {
      expect(() => service.assertDirectValueAllowed(def, pos)).not.toThrow();
    }
  });

  it('BOTH + override disabled: versions always refused, regardless of parent state', () => {
    const def = definitionRow({ applicability: 'BOTH', childOverrideAllowed: false }) as any;
    expect(() => service.assertDirectValueAllowed(def, parentPos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, alonePos)).not.toThrow();
    expect(() => service.assertDirectValueAllowed(def, childPos)).toThrow(BadRequestException);
  });
});

describe('resolveEffectiveValues', () => {
  const rowFor = (productId: string, text: string) => ({
    product: { id: productId },
    definition: { id: DEF },
    valueText: text,
    valueNumber: null,
    valueBoolean: null,
    valueDate: null,
  });

  it('a direct child value WINS over the inherited parent value', async () => {
    const { service, em } = serviceWith({
      'find:ProductFieldValue': () => [rowFor(PARENT_ID, 'oak'), rowFor(CHILD_ID, 'walnut')],
    });
    const resolved = await service.resolveEffectiveValues(
      em,
      [{ id: CHILD_ID, parentId: PARENT_ID }],
      [definitionRow() as any],
    );
    const entry = resolved.get(CHILD_ID)!.get(DEF)!;
    expect(entry.source).toBe('DIRECT');
    expect(entry.sourceProductId).toBe(CHILD_ID);
    expect(entry.row.valueText).toBe('walnut');
  });

  it('absence of a child value inherits the parent value, labeled as such', async () => {
    const { service, em } = serviceWith({
      'find:ProductFieldValue': () => [rowFor(PARENT_ID, 'oak')],
    });
    const resolved = await service.resolveEffectiveValues(
      em,
      [{ id: CHILD_ID, parentId: PARENT_ID }],
      [definitionRow() as any],
    );
    const entry = resolved.get(CHILD_ID)!.get(DEF)!;
    expect(entry.source).toBe('INHERITED');
    expect(entry.sourceProductId).toBe(PARENT_ID);
    expect(entry.row.valueText).toBe('oak');
  });

  it('CHILD-only definitions never inherit — nothing to inherit from', async () => {
    const { service, em } = serviceWith({
      'find:ProductFieldValue': () => [rowFor(PARENT_ID, 'oak')],
    });
    const resolved = await service.resolveEffectiveValues(
      em,
      [{ id: CHILD_ID, parentId: PARENT_ID }],
      [definitionRow({ applicability: 'CHILD' }) as any],
    );
    expect(resolved.get(CHILD_ID)!.has(DEF)).toBe(false);
  });

  it('standalone products resolve direct values only', async () => {
    const { service, em } = serviceWith({
      'find:ProductFieldValue': () => [rowFor(ALONE_ID, 'steel')],
    });
    const resolved = await service.resolveEffectiveValues(
      em,
      [{ id: ALONE_ID, parentId: null }],
      [definitionRow() as any],
    );
    const entry = resolved.get(ALONE_ID)!.get(DEF)!;
    expect(entry.source).toBe('DIRECT');
  });

  it('an unanswered definition resolves to nothing, never to null-copying', async () => {
    const { service, em } = serviceWith({ 'find:ProductFieldValue': () => [] });
    const resolved = await service.resolveEffectiveValues(
      em,
      [{ id: CHILD_ID, parentId: PARENT_ID }],
      [definitionRow() as any],
    );
    expect(resolved.get(CHILD_ID)!.size).toBe(0);
  });
});

describe('upsertValue applies applicability at the write boundary', () => {
  it('refuses a version write on a PARENT-only definition', async () => {
    const { service } = serviceWith({
      'findOne:Product': () => ({ id: CHILD_ID, parent: { id: PARENT_ID } }),
      'findOne:ProductFieldDefinition': () => definitionRow({ applicability: 'PARENT' }),
    });
    await expect(service.upsertValue(orgWide, CHILD_ID, DEF, { value: 'oak' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses a model write on a CHILD-only definition', async () => {
    const { service } = serviceWith({
      'findOne:Product': () => ({ id: PARENT_ID, parent: null }),
      'findOne:ProductFieldDefinition': () => definitionRow({ applicability: 'CHILD' }),
      'count:Product': () => 2, // it has versions
    });
    await expect(service.upsertValue(orgWide, PARENT_ID, DEF, { value: 'blue' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a version override where the policy allows it', async () => {
    const { service } = serviceWith({
      'findOne:Product': () => ({ id: CHILD_ID, parent: { id: PARENT_ID } }),
      'findOne:ProductFieldDefinition': () => definitionRow({ applicability: 'BOTH', childOverrideAllowed: true }),
    });
    const result = await service.upsertValue(orgWide, CHILD_ID, DEF, { value: 'walnut' } as any);
    expect(result.value).toBe('walnut');
  });

  it('refuses a version write when the override policy forbids it', async () => {
    const { service } = serviceWith({
      'findOne:Product': () => ({ id: CHILD_ID, parent: { id: PARENT_ID } }),
      'findOne:ProductFieldDefinition': () => definitionRow({ applicability: 'BOTH', childOverrideAllowed: false }),
    });
    await expect(service.upsertValue(orgWide, CHILD_ID, DEF, { value: 'walnut' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('typed value matrix — the new Phase 2 types', () => {
  const upsertWith = async (definition: any, value: unknown) => {
    const { service } = serviceWith({
      'findOne:Product': () => ({ id: ALONE_ID, parent: null }),
      'findOne:ProductFieldDefinition': () => definition,
    });
    return service.upsertValue(orgWide, ALONE_ID, DEF, { value } as any);
  };

  it('SELECT accepts exactly the definition options', async () => {
    const def = definitionRow({ type: ProductFieldType.SELECT, options: ['Oak', 'Walnut'] });
    expect((await upsertWith(def, 'Oak')).value).toBe('Oak');
    await expect(upsertWith(def, 'Pine')).rejects.toThrow(BadRequestException);
    await expect(upsertWith(def, '')).rejects.toThrow(BadRequestException);
  });

  it('DATE accepts real ISO dates only', async () => {
    const def = definitionRow({ type: ProductFieldType.DATE });
    expect((await upsertWith(def, '2026-08-05')).value).toBe('2026-08-05');
    await expect(upsertWith(def, '2026-02-30')).rejects.toThrow(BadRequestException);
    await expect(upsertWith(def, '05/08/2026')).rejects.toThrow(BadRequestException);
  });

  it('URL accepts absolute http(s) only', async () => {
    const def = definitionRow({ type: ProductFieldType.URL });
    expect((await upsertWith(def, 'https://example.com/manual.pdf')).value).toBe('https://example.com/manual.pdf');
    await expect(upsertWith(def, 'ftp://example.com/x')).rejects.toThrow(BadRequestException);
    await expect(upsertWith(def, 'not a url')).rejects.toThrow(BadRequestException);
  });

  it('curated NUMBER constraints refuse out-of-range and non-integer values', async () => {
    const width = definitionRow({
      key: 'width',
      type: ProductFieldType.NUMBER,
      unit: 'cm',
      source: 'CURATED',
    });
    expect((await upsertWith(width, '120.5')).value).toBe('120.5');
    await expect(upsertWith(width, '0')).rejects.toThrow(BadRequestException); // exclusive minimum
    const leadTime = definitionRow({
      key: 'lead-time',
      type: ProductFieldType.NUMBER,
      unit: 'days',
      source: 'CURATED',
    });
    expect((await upsertWith(leadTime, '30')).value).toBe('30');
    await expect(upsertWith(leadTime, '30.5')).rejects.toThrow(BadRequestException); // integer only
    await expect(upsertWith(leadTime, '4000')).rejects.toThrow(BadRequestException); // above max
  });

  it('curated TEXT length ceilings apply; CUSTOM text is unlimited by registry', async () => {
    const country = definitionRow({ key: 'country', source: 'CURATED' });
    await expect(upsertWith(country, 'x'.repeat(121))).rejects.toThrow(BadRequestException);
    const custom = definitionRow({ key: 'anything', source: 'CUSTOM' });
    expect((await upsertWith(custom, 'x'.repeat(121))).value).toHaveLength(121);
  });
});
