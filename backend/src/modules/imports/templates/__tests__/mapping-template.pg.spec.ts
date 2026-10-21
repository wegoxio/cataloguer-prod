import { EntityManager } from '@mikro-orm/postgresql';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { MappingTemplateService, TemplateShape } from '../mapping-template.service';
import { TableMapping } from '../../preview/normalized-preview';

/**
 * Template persistence against real PostgreSQL.
 *
 * The properties that matter here are all about what the DATABASE guarantees:
 * that versions are unique per name, that a template belongs to exactly one
 * organization, and that saving a new version never rewrites an old one. An
 * in-memory test would assert the service's intentions rather than the
 * constraints that actually hold the line.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const SHAPE: TemplateShape = {
  headers: ['Nombre', 'Precio'],
  types: ['TEXT', 'DECIMAL'],
};

const MAPPING: TableMapping = {
  sheet: 'Productos',
  headerRow: 1,
  columns: [
    { columnIndex: 0, header: 'Nombre', field: 'name' },
    { columnIndex: 1, header: 'Precio', field: 'price' },
  ],
};

d('saved mappings (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: MappingTemplateService;
  let orgA: string;
  let orgB: string;

  const newOrg = async (label: string): Promise<string> => {
    const id = randomUUID();
    await pg.orm.em.getConnection().execute(
      `insert into organizations (id, name, slug, created_at, updated_at)
       values (?, ?, ?, now(), now())`,
      [id, label, `${label}-${id.slice(0, 8)}`.toLowerCase()],
    );
    return id;
  };

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    service = new MappingTemplateService(em);
    orgA = await newOrg('tpl-a');
    orgB = await newOrg('tpl-b');
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('saves a mapping as version 1', async () => {
    const saved = await service.save({
      organizationId: orgA,
      name: 'WooCommerce mensual',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });
    expect(saved.version).toBe(1);
    expect(saved.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds a NEW version rather than rewriting the old one', async () => {
    // A plan executed last month referenced the mapping as it was then.
    // Rewriting it would make the audit trail describe something that never
    // happened.
    const before = await service.save({
      organizationId: orgA,
      name: 'Versionada',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });

    const changed: TableMapping = {
      ...MAPPING,
      columns: [{ columnIndex: 0, header: 'Nombre', field: 'name' }],
    };
    const after = await service.save({
      organizationId: orgA,
      name: 'Versionada',
      importType: 'PRODUCTS',
      mapping: changed,
      shape: SHAPE,
    });

    expect(after.version).toBe(before.version + 1);

    // Version 1 is still exactly what it was.
    const original = await service.load(orgA, before.id);
    expect((original.mapping as TableMapping).columns).toHaveLength(2);
  });

  it('offers only the newest version of each name', async () => {
    const list = await service.listLatest(orgA, 'PRODUCTS');
    const versionada = list.filter((t) => t.name === 'Versionada');
    expect(versionada).toHaveLength(1);
    expect(versionada[0].version).toBe(2);
  });

  it('lets two organizations use the same template name independently', async () => {
    // Tenants name things after their own processes; "Mensual" is not ours to
    // reserve globally.
    const a = await service.save({
      organizationId: orgA,
      name: 'Compartido',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });
    const b = await service.save({
      organizationId: orgB,
      name: 'Compartido',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  it("refuses to load another organization's template, as though it did not exist", async () => {
    // A 404 rather than a 403: confirming a template exists is itself a
    // disclosure, and its name can carry a customer's own vocabulary.
    const a = await service.save({
      organizationId: orgA,
      name: 'Privada',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });
    await expect(service.load(orgB, a.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("never lists another organization's templates", async () => {
    const listB = await service.listLatest(orgB);
    expect(listB.every((t) => t.name === 'Compartido')).toBe(true);
  });

  it('refuses to save a mapping this version could not execute', async () => {
    // Otherwise it fails at execution time, long after the person who saved it
    // has moved on.
    await expect(
      service.save({
        organizationId: orgA,
        name: 'Imposible',
        importType: 'PRODUCTS',
        mapping: {
          ...MAPPING,
          columns: [{ columnIndex: 0, header: 'Nombre', field: 'name', transformations: [{ kind: 'EVAL' as never }] }],
        },
        shape: SHAPE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a template with no name', async () => {
    await expect(
      service.save({ organizationId: orgA, name: '   ', importType: 'PRODUCTS', mapping: MAPPING, shape: SHAPE }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stops offering an archived template without destroying it', async () => {
    const t = await service.save({
      organizationId: orgA,
      name: 'Obsoleta',
      importType: 'PRODUCTS',
      mapping: MAPPING,
      shape: SHAPE,
    });
    await service.archive(orgA, t.id);

    const list = await service.listLatest(orgA, 'PRODUCTS');
    expect(list.some((x) => x.name === 'Obsoleta')).toBe(false);
    // Still loadable, because a past plan may reference it.
    await expect(service.load(orgA, t.id)).resolves.toMatchObject({ name: 'Obsoleta' });
  });

  it('separates templates by import type', async () => {
    await service.save({
      organizationId: orgA,
      name: 'Ventas históricas',
      importType: 'HISTORICAL_STORE_SALES',
      mapping: MAPPING,
      shape: SHAPE,
    });
    const products = await service.listLatest(orgA, 'PRODUCTS');
    expect(products.some((t) => t.name === 'Ventas históricas')).toBe(false);

    const sales = await service.listLatest(orgA, 'HISTORICAL_STORE_SALES');
    expect(sales.map((t) => t.name)).toEqual(['Ventas históricas']);
  });

  it('lets the DATABASE settle a version race, rather than trusting the read', async () => {
    // Two people saving at once must not both claim the same version. The
    // unique index on (organization, name, version) is what decides.
    const conn = pg.orm.em.getConnection();
    const name = 'Carrera';
    await service.save({ organizationId: orgA, name, importType: 'PRODUCTS', mapping: MAPPING, shape: SHAPE });

    await expect(
      conn.execute(
        `insert into import_mapping_templates
           (organization_id, name, version, import_type, source_fingerprint, source_headers, mapping, created_at, updated_at)
         values (?, ?, 1, 'PRODUCTS', repeat('a',64), '{}'::jsonb, '{}'::jsonb, now(), now())`,
        [orgA, name],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`mapping template PG suite skipped: ${gate.reason}`);
}
