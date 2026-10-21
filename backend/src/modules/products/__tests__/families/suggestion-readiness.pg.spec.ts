import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { Product } from '../../entities/product.entity';
import { realStock } from '../../../../../test/inventory-stock-support';
import { SUGGESTION_BLOCKED_REASONS } from '../../families/suggestion-readiness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'op@e.test' } as any;

/**
 * WHETHER A SUGGESTION COULD ACTUALLY BE ACCEPTED.
 *
 * `confidentGroups` reads names. Creation enforces shops, publication status
 * and specification values — so a suggestion could always propose a group the
 * create endpoint would refuse, and the only way to find out was to press the
 * button and read a red toast. Readiness answers it up front, from the same
 * conditions `assertFamilyCreatable` enforces, and reports stable CODES rather
 * than exception text.
 */
d('suggestion readiness (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let ORG: string;
  let STORE: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  /** A product whose NAME will make the heuristic group it with its siblings. */
  const mkNamed = async (
    name: string,
    over: { status?: string; inStore?: boolean; organizationId?: string; storeId?: string } = {},
  ) => {
    const org = over.organizationId ?? ORG;
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, ?, 10, false, now(), now()) returning id`,
      [name, uid('slug'), org, over.status ?? 'PUBLISHED'],
    );
    if (over.inStore !== false) {
      await exec(
        `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
        [org, over.storeId ?? STORE, row.id],
      );
    }
    return row.id;
  };

  /**
   * A family the heuristic will actually propose.
   *
   * It needs at least TWO shared leading words before the option word, and the
   * leftover has to read as a colour or a size — so "Camiseta <tag> roja" and
   * "Camiseta <tag> azul" group under "Camiseta <tag>", while "Camiseta roja"
   * and "Camiseta azul" are not proposed at all. The tag keeps each test's
   * group distinct from every other test's in the same database.
   */
  const tagFor = () =>
    randomUUID()
      .slice(0, 8)
      .replace(/[^a-z]/g, 'x');

  const suggestionTagged = async (tag: string, storeScopeId?: string) => {
    const all = await products.findFamilySuggestions(ORG, storeScopeId);
    return all.find((s) => s.name.toLowerCase().includes(tag.toLowerCase()));
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
    const fields = new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, guard);
    products = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Product) as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      {
        learnFromAcceptedGroup: async () => undefined,
        learnedWordsFor: async () => [],
        dismissedSignaturesFor: async () => [],
      } as any,
      guard,
      fields,
      realStock(em as any),
    );
    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Sugg Co', ?, now(), now()) returning id`,
        [uid('sugg')],
      )
    )[0].id;
    STORE = (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Centro', ?, ?::uuid, now(), now()) returning id`,
        [uid('centro'), ORG],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('READY: every member published, in a shop, and free of conflicting values', async () => {
    const tag = tagFor();
    await mkNamed(`Camiseta ${tag} roja`);
    await mkNamed(`Camiseta ${tag} azul`);
    const s = await suggestionTagged(tag);
    expect(s).toBeTruthy();
    expect(s!.readiness).toBe('READY');
    expect(s!.blockedReasons).toEqual([]);
    expect(s!.members.every((m) => m.hasStore)).toBe(true);
    expect(s!.members.every((m) => m.status === 'PUBLISHED')).toBe(true);
  });

  it('BLOCKED · MIXED_PUBLICATION_STATUS, and the members say which is which', async () => {
    const tag = tagFor();
    await mkNamed(`Mesa ${tag} roja`);
    await mkNamed(`Mesa ${tag} azul`, { status: 'DRAFT' });
    const s = await suggestionTagged(tag);
    expect(s!.readiness).toBe('BLOCKED');
    expect(s!.blockedReasons).toContain('MIXED_PUBLICATION_STATUS');
    expect(s!.members.map((m) => m.status).sort()).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('BLOCKED · MEMBER_WITHOUT_STORE, and the member without one is identifiable', async () => {
    const tag = tagFor();
    await mkNamed(`Silla ${tag} roja`);
    await mkNamed(`Silla ${tag} azul`, { inStore: false });
    const s = await suggestionTagged(tag);
    expect(s!.readiness).toBe('BLOCKED');
    expect(s!.blockedReasons).toContain('MEMBER_WITHOUT_STORE');
    expect(s!.members.filter((m) => !m.hasStore)).toHaveLength(1);
  });

  it('BLOCKED · SPECIFICATION_CONFLICT for a member holding a parent-only value', async () => {
    const tag = tagFor();
    const a = await mkNamed(`Lampara ${tag} roja`);
    await mkNamed(`Lampara ${tag} azul`);
    const [def] = await exec<{ id: string }[]>(
      `insert into product_field_definitions (organization_id, key, label, type, applicability, created_at, updated_at)
       values (?::uuid, ?, 'Parent only', 'TEXT', 'PARENT', now(), now()) returning id`,
      [ORG, `parentonly${randomUUID().slice(0, 8).replace(/-/g, '')}`],
    );
    await exec(
      `insert into product_field_values (organization_id, product_id, definition_id, definition_type, value_text, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, 'TEXT', 'oak', now(), now())`,
      [ORG, a, def.id],
    );
    const s = await suggestionTagged(tag);
    expect(s!.readiness).toBe('BLOCKED');
    expect(s!.blockedReasons).toContain('SPECIFICATION_CONFLICT');
    expect(s!.members.filter((m) => m.hasSpecificationConflict).map((m) => m.id)).toEqual([a]);
  });

  it('a BLOCKED suggestion really is refused by the authoritative create', async () => {
    const tag = tagFor();
    await mkNamed(`Prueba ${tag} roja`);
    await mkNamed(`Prueba ${tag} azul`, { status: 'DRAFT' });
    const s = await suggestionTagged(tag);
    expect(s!.readiness).toBe('BLOCKED');
    await expect(
      products.createFamily(
        s!.name,
        s!.members.map((m) => ({ id: m.id, label: m.label })),
        ACTOR,
      ),
    ).rejects.toThrow(/not all published or all draft/i);
  });

  it('a READY suggestion really is accepted', async () => {
    const tag = tagFor();
    await mkNamed(`Acepta ${tag} roja`);
    await mkNamed(`Acepta ${tag} azul`);
    const s = await suggestionTagged(tag);
    expect(s!.readiness).toBe('READY');
    const created = await products.createFamily(
      s!.name,
      s!.members.map((m) => ({ id: m.id, label: m.label })),
      ACTOR,
    );
    expect(created.members).toBe(2);
  });

  it('every reason it reports is in the closed vocabulary', async () => {
    const all = await products.findFamilySuggestions(ORG, undefined);
    for (const s of all) {
      for (const reason of s.blockedReasons) expect(SUGGESTION_BLOCKED_REASONS).toContain(reason);
      expect(s.readiness).toBe(s.blockedReasons.length === 0 ? 'READY' : 'BLOCKED');
    }
  });

  it('the added fields change no candidate: the same groups, with the same members', async () => {
    const all = await products.findFamilySuggestions(ORG, undefined);
    for (const s of all) {
      expect(s.members.length).toBeGreaterThanOrEqual(2);
      // Every member is still an ungrouped, unarchived product of this company.
      const ids = s.members.map((m) => m.id);
      const [{ n }] = await exec<{ n: number }[]>(
        `select count(*)::int n from products
          where id in (${ids.map(() => '?::uuid').join(',')})
            and organization_id = ?::uuid and archived_at is null and parent_id is null`,
        [...ids, ORG],
      );
      expect(n).toBe(ids.length);
    }
  });

  describe('tenant and store isolation', () => {
    it('REFUSES to answer without a company at all', async () => {
      // A suggestion list with no company is not a smaller list — it is
      // somebody else's catalogue. This path filtered by store when narrowed
      // and by nothing otherwise, so an organization-wide reader saw every
      // company's ungrouped products.
      await expect(products.findFamilySuggestions(null, undefined)).rejects.toThrow(
        /requires an organization context/i,
      );
    });

    it('never proposes a member from another company', async () => {
      const other = (
        await exec<{ id: string }[]>(
          `insert into organizations (id, name, slug, created_at, updated_at)
           values (gen_random_uuid(), 'Rival', ?, now(), now()) returning id`,
          [uid('rival')],
        )
      )[0].id;
      const otherStore = (
        await exec<{ id: string }[]>(
          `insert into stores (id, name, slug, organization_id, created_at, updated_at)
           values (gen_random_uuid(), 'Rival centro', ?, ?::uuid, now(), now()) returning id`,
          [uid('rcentro'), other],
        )
      )[0].id;
      const tag = tagFor();
      const foreignA = await mkNamed(`Ajena ${tag} roja`, { organizationId: other, storeId: otherStore });
      const foreignB = await mkNamed(`Ajena ${tag} azul`, { organizationId: other, storeId: otherStore });

      const all = await products.findFamilySuggestions(ORG, undefined);
      const ids = all.flatMap((s) => s.members.map((m) => m.id));
      expect(ids).not.toContain(foreignA);
      expect(ids).not.toContain(foreignB);
    });

    it('a store-narrowed reader is proposed only members of that shop', async () => {
      const otherStore = (
        await exec<{ id: string }[]>(
          `insert into stores (id, name, slug, organization_id, created_at, updated_at)
           values (gen_random_uuid(), 'Norte', ?, ?::uuid, now(), now()) returning id`,
          [uid('norte'), ORG],
        )
      )[0].id;
      const tag = tagFor();
      const inNorth = await mkNamed(`Nortena ${tag} roja`, { storeId: otherStore });
      const alsoNorth = await mkNamed(`Nortena ${tag} azul`, { storeId: otherStore });

      const narrowed = await products.findFamilySuggestions(ORG, STORE);
      const ids = narrowed.flatMap((s) => s.members.map((m) => m.id));
      expect(ids).not.toContain(inNorth);
      expect(ids).not.toContain(alsoNorth);
    });
  });

  it('READINESS IS BOUNDED: the same queries however many suggestions there are', async () => {
    /*
     * COUNTED TWICE, not asserted against a constant.
     *
     * A number written into the test is only ever as good as the day it was
     * written: it passes a per-suggestion query that happens to be shaped
     * differently, and it fails an unrelated refactor that legitimately adds
     * one. Counting every statement the call issues, before and after twelve
     * more groups exist, is the property itself — the work must not grow with
     * the number of suggestions.
     */
    const measure = async () => {
      const seen: string[] = [];
      const original = (em as any).execute.bind(em);
      (em as any).execute = (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string') seen.push(sql);
        return original(sql, params);
      };
      try {
        const all = await products.findFamilySuggestions(ORG, undefined);
        return { seen, count: all.length };
      } finally {
        (em as any).execute = original;
      }
    };

    const before = await measure();
    for (let i = 0; i < 12; i++) {
      const tag = tagFor();
      await mkNamed(`Bulto${i} ${tag} roja`);
      await mkNamed(`Bulto${i} ${tag} azul`);
    }
    const after = await measure();

    expect(after.count).toBeGreaterThanOrEqual(before.count + 12);
    expect(after.seen).toHaveLength(before.seen.length);
    // And the two readiness statements are asked once each, not once per group.
    for (const shape of ['from store_products where product_id in', 'product_field_definitions']) {
      expect(after.seen.filter((sql) => sql.includes(shape))).toHaveLength(1);
    }
  });
});
