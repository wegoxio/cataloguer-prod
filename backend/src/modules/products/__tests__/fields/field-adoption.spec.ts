import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CuratedFieldRegistryService } from '../../fields/curated-field-registry.service';
import { ProductFieldType } from '../../entities/product-field-definition.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Phase 2: curated activation and adoption.
 *
 * Activation is idempotent per organization and never hijacks a CUSTOM key;
 * adoption flips a COMPATIBLE existing row to CURATED in place — id, values
 * and settings preserved — and refuses anything incompatible with a precise,
 * bounded report over the COMPLETE value set.
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const DEF = '00000000-0000-4000-8000-0000000000d1';

const orgWide: TenantScope = {
  platform: false,
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: [],
  role: 'ORGANIZATION_MANAGER',
};
const branchBound: TenantScope = { ...orgWide, storeId: '00000000-0000-4000-8000-0000000000s1', role: 'ADMIN' };

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
    execute: jest.fn(async (...args: any[]) => (handlers['execute'] ? handlers['execute'](...args) : [])),
  };
  const em: any = { ...tem, transactional: jest.fn(async (cb: any) => cb(tem)) };
  const service = new CuratedFieldRegistryService(em as any);
  return { service, tem, created };
}

const customRow = (over: Record<string, any> = {}) => ({
  id: DEF,
  organization: { id: ORG },
  key: 'color',
  label: 'Colour', // tenant customization — must survive adoption
  type: ProductFieldType.TEXT,
  unit: null as string | null,
  source: 'CUSTOM',
  fieldGroup: null as string | null,
  applicability: 'BOTH',
  childOverrideAllowed: true,
  options: null,
  sortOrder: 5,
  archivedAt: null as Date | null,
  ...over,
});

describe('curated activation', () => {
  it('materializes the registry entry once, with registry defaults', async () => {
    const { service, created } = serviceWith({ 'findOne:ProductFieldDefinition': () => null });
    await service.activate(orgWide, 'width');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      key: 'width',
      type: ProductFieldType.NUMBER,
      unit: 'cm',
      source: 'CURATED',
      fieldGroup: 'dimensions',
      applicability: 'BOTH',
    });
  });

  it('is idempotent: an already-CURATED row returns unchanged', async () => {
    const existing = customRow({
      key: 'width',
      type: ProductFieldType.NUMBER,
      unit: 'cm',
      source: 'CURATED',
      label: 'Anchura',
    });
    const { service, created } = serviceWith({ 'findOne:ProductFieldDefinition': () => existing });
    const result = await service.activate(orgWide, 'width');
    expect(created).toHaveLength(0);
    expect(result.label).toBe('Anchura'); // tenant relabel untouched
  });

  it('refuses a CUSTOM key collision with the compatibility report, never hijacking', async () => {
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => customRow(),
      'find:ProductFieldValue': () => [],
    });
    const err = await service.activate(orgWide, 'color').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as any;
    expect(body.code).toBe('CURATED_KEY_HELD_BY_CUSTOM_FIELD');
    expect(body.report.existingDefinitionId).toBe(DEF);
  });

  it('unknown curated keys are 404; missing org context is 400; branch scope is refused', async () => {
    const { service } = serviceWith();
    await expect(service.activate(orgWide, 'nonsense')).rejects.toThrow(NotFoundException);
    await expect(service.activate(undefined, 'width')).rejects.toThrow(BadRequestException);
    await expect(service.activate(branchBound, 'width')).rejects.toThrow(BadRequestException);
  });
});

describe('curated adoption', () => {
  it('adopts a compatible CUSTOM row in place: id, label, order preserved; registry fills gaps', async () => {
    const existing = customRow(); // TEXT color, no values
    const { service, created } = serviceWith({
      'findOne:ProductFieldDefinition': () => existing,
      'find:ProductFieldValue': () => [],
      'count:ProductFieldValue': () => 0,
    });
    const result = await service.adopt(orgWide, 'color');
    expect(created).toHaveLength(0); // nothing recreated
    expect(existing.source).toBe('CURATED');
    expect(result.id).toBe(DEF);
    expect(result.label).toBe('Colour'); // customization preserved
    expect(result.group).toBe('materials'); // registry default filled
    expect(existing.applicability).toBe('CHILD'); // registry applicability applied
    expect(result.sortOrder).toBe(5); // tenant ordering preserved
  });

  it('is idempotent on an already-CURATED row', async () => {
    const existing = customRow({ source: 'CURATED' });
    const { service } = serviceWith({ 'findOne:ProductFieldDefinition': () => existing });
    const result = await service.adopt(orgWide, 'color');
    expect(result.id).toBe(DEF);
  });

  it('refuses a type mismatch precisely', async () => {
    const existing = customRow({ key: 'width', type: ProductFieldType.TEXT });
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => existing,
      'find:ProductFieldValue': () => [],
    });
    const err = await service.adopt(orgWide, 'width').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as any;
    expect(body.code).toBe('CURATED_ADOPTION_INCOMPATIBLE');
    expect(body.report.mismatches).toContainEqual({ aspect: 'type', expected: 'NUMBER', actual: 'TEXT' });
  });

  it('refuses a unit-less NUMBER row that already has values (meaning unknown)', async () => {
    const existing = customRow({ key: 'width', type: ProductFieldType.NUMBER, unit: null });
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => existing,
      'find:ProductFieldValue': () => [
        { product: { id: 'p1' }, valueNumber: '10', valueText: null, valueBoolean: null, valueDate: null },
      ],
    });
    const err = await service.adopt(orgWide, 'width').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as any;
    expect(body.report.mismatches.some((m: any) => m.aspect === 'unit')).toBe(true);
  });

  it('validates the COMPLETE value set and reports violations with a bounded sample', async () => {
    const values = Array.from({ length: 15 }, (_, i) => ({
      product: { id: `00000000-0000-4000-8000-0000000000${(i + 10).toString(16)}` },
      valueNumber: '-5', // violates the exclusive minimum
      valueText: null,
      valueBoolean: null,
      valueDate: null,
    }));
    const existing = customRow({ key: 'width', type: ProductFieldType.NUMBER, unit: 'cm' });
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => existing,
      'find:ProductFieldValue': () => values,
      execute: () => [],
    });
    const err = await service.adopt(orgWide, 'width').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as any;
    expect(body.report.valueViolations.count).toBe(15); // complete evaluation
    expect(body.report.valueViolations.sampleProductIds).toHaveLength(10); // bounded report
    expect(body.report.valueViolations.truncated).toBe(true);
  });

  it('refuses when existing values sit on the side the registry applicability excludes', async () => {
    // Curated color is CHILD-only; a family MODEL holding a color value blocks.
    const existing = customRow();
    const { service } = serviceWith({
      'findOne:ProductFieldDefinition': () => existing,
      'find:ProductFieldValue': () => [
        { product: { id: 'model-1' }, valueText: 'blue', valueNumber: null, valueBoolean: null, valueDate: null },
      ],
      execute: () => [{ id: 'model-1', has_parent: false, has_children: true }],
    });
    const err = await service.adopt(orgWide, 'color').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as any;
    expect(body.report.mismatches.some((m: any) => m.aspect === 'applicability')).toBe(true);
  });

  it('is tenant-invisible: a foreign or missing row is 404', async () => {
    const { service } = serviceWith({ 'findOne:ProductFieldDefinition': () => null });
    await expect(service.adopt(orgWide, 'color')).rejects.toThrow(NotFoundException);
  });
});
