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

/**
 * THE TENANT BOUNDARY OF DISCOVERY.
 *
 * `findFamilySuggestions` had no organization clause. It filtered by store
 * when the reader was narrowed and by NOTHING otherwise, so any reader with an
 * organization-wide role — and the endpoint carries no role restriction, so
 * that is every authenticated role — received every company's ungrouped
 * products: names, identifiers, option labels and prices. That is a
 * cross-tenant disclosure, and it is fixed by requiring the organization at
 * the query rather than filtering afterwards.
 *
 * These regressions exist so it cannot come back quietly. They use two
 * companies with DELIBERATELY LOOK-ALIKE product names, because the failure
 * mode is not only "the other company appears" — it is "the other company's
 * items merge into this company's group and become indistinguishable".
 */
d('suggestion discovery · the tenant boundary (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let ORG_A: string;
  let ORG_B: string;
  let A1: string;
  let A2: string;
  let B1: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;
  const tagFor = () =>
    randomUUID()
      .slice(0, 8)
      .replace(/[^a-z]/g, 'x');

  const mkOrg = async (label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, now(), now()) returning id`,
        [label, uid(label)],
      )
    )[0].id;

  const mkStore = async (organizationId: string, label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?::uuid, now(), now()) returning id`,
        [label, uid(label), organizationId],
      )
    )[0].id;

  const mkNamed = async (name: string, organizationId: string, storeId: string | null) => {
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, now(), now()) returning id`,
      [name, uid('slug'), organizationId],
    );
    if (storeId) {
      await exec(
        `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
        [organizationId, storeId, row.id],
      );
    }
    return row.id;
  };

  const idsIn = (list: { members: { id: string }[] }[]) => list.flatMap((s) => s.members.map((m) => m.id));

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
    ORG_A = await mkOrg('Tenant A');
    ORG_B = await mkOrg('Tenant B');
    A1 = await mkStore(ORG_A, 'A uno');
    A2 = await mkStore(ORG_A, 'A dos');
    B1 = await mkStore(ORG_B, 'B uno');
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('the organization is required at the query', () => {
    it('refuses to answer with no company at all', async () => {
      await expect(products.findFamilySuggestions(null, undefined)).rejects.toThrow(
        /requires an organization context/i,
      );
      await expect(products.findFamilySuggestions(undefined, undefined)).rejects.toThrow(
        /requires an organization context/i,
      );
    });

    /**
     * FAILS CLOSED, and specifically not by returning a smaller list. An
     * unscoped answer is not a degraded answer, it is somebody else's data.
     */
    it('refuses rather than answering unscoped, even with a store narrowing present', async () => {
      await expect(products.findFamilySuggestions(null, A1)).rejects.toThrow(/requires an organization context/i);
    });

    /**
     * The clause is in the WHERE, not applied to the rows afterwards. A filter
     * that runs after the fact still reads the other company's rows, and a
     * later refactor that forgets the post-filter re-opens the disclosure.
     */
    it('names the organization in the SQL the database actually runs', async () => {
      const tag = tagFor();
      await mkNamed(`Consulta ${tag} roja`, ORG_A, A1);
      await mkNamed(`Consulta ${tag} azul`, ORG_A, A1);

      const seen: string[] = [];
      const connection = (em as any).getConnection();
      const original: (...args: any[]) => any = connection.execute.bind(connection);
      connection.execute = (...args: any[]) => {
        if (typeof args[0] === 'string') seen.push(args[0]);
        return original(...args);
      };
      try {
        await products.findFamilySuggestions(ORG_A, undefined);
      } finally {
        connection.execute = original;
      }
      // Jest's expect takes no message argument, so the claim is in the name.
      const candidateQuery = seen.find((sql) => /from "products"/i.test(sql) && /parent_id/i.test(sql));
      expect(candidateQuery).toBeTruthy();
      expect(candidateQuery).toMatch(/organization_id/i);
    });
  });

  describe('two companies whose products are named alike', () => {
    it('never proposes another company as a member', async () => {
      const tag = tagFor();
      const mine = [await mkNamed(`Camiseta ${tag} roja`, ORG_A, A1), await mkNamed(`Camiseta ${tag} azul`, ORG_A, A1)];
      const theirs = [
        await mkNamed(`Camiseta ${tag} verde`, ORG_B, B1),
        await mkNamed(`Camiseta ${tag} negra`, ORG_B, B1),
      ];

      const a = await products.findFamilySuggestions(ORG_A, undefined);
      const b = await products.findFamilySuggestions(ORG_B, undefined);

      expect(idsIn(a)).toEqual(expect.arrayContaining(mine));
      for (const id of theirs) expect(idsIn(a)).not.toContain(id);
      expect(idsIn(b)).toEqual(expect.arrayContaining(theirs));
      for (const id of mine) expect(idsIn(b)).not.toContain(id);
    });

    /**
     * The sharpest form of the leak: identically-named items MERGE into one
     * group, so the reader cannot tell which company an item came from and
     * grouping them would attempt a cross-tenant write.
     */
    it('does not merge look-alikes into one group', async () => {
      const tag = tagFor();
      await mkNamed(`Bufanda ${tag} roja`, ORG_A, A1);
      await mkNamed(`Bufanda ${tag} azul`, ORG_A, A1);
      await mkNamed(`Bufanda ${tag} verde`, ORG_B, B1);
      await mkNamed(`Bufanda ${tag} negra`, ORG_B, B1);

      const a = await products.findFamilySuggestions(ORG_A, undefined);
      const group = a.find((s) => s.name.toLowerCase().includes(tag));
      expect(group).toBeTruthy();
      expect(group!.members).toHaveLength(2);
      expect(group!.members.map((m) => m.label).sort()).toEqual(['azul', 'roja']);
    });

    it('counts describe this company only', async () => {
      const tag = tagFor();
      await mkNamed(`Cinturon ${tag} roja`, ORG_B, B1);
      await mkNamed(`Cinturon ${tag} azul`, ORG_B, B1);

      const a = await products.findFamilySuggestions(ORG_A, undefined);
      const b = await products.findFamilySuggestions(ORG_B, undefined);
      // The counts the controller publishes are derived from these lists, so a
      // count that saw more than its own company would need a longer list.
      expect(a.every((s) => idsIn([s]).length >= 2)).toBe(true);
      expect(a.find((s) => s.name.toLowerCase().includes(tag))).toBeUndefined();
      expect(b.find((s) => s.name.toLowerCase().includes(tag))).toBeTruthy();
    });

    /**
     * Nothing is memoized between calls. If a per-process cache were ever
     * introduced without the company in its key, interleaving the two tenants
     * is what would expose it.
     */
    it('answers each company afresh when the two are interleaved', async () => {
      const first = idsIn(await products.findFamilySuggestions(ORG_A, undefined)).sort();
      const other = idsIn(await products.findFamilySuggestions(ORG_B, undefined)).sort();
      const again = idsIn(await products.findFamilySuggestions(ORG_A, undefined)).sort();
      const otherAgain = idsIn(await products.findFamilySuggestions(ORG_B, undefined)).sort();

      expect(again).toEqual(first);
      expect(otherAgain).toEqual(other);
      expect(first).not.toEqual(other);
      expect(first.filter((id) => other.includes(id))).toEqual([]);
    });
  });

  describe('a reader narrowed to one branch', () => {
    it('is proposed only members of that branch', async () => {
      const tag = tagFor();
      const inA1 = [await mkNamed(`Zapato ${tag} roja`, ORG_A, A1), await mkNamed(`Zapato ${tag} azul`, ORG_A, A1)];
      const inA2 = [await mkNamed(`Sandalia ${tag} roja`, ORG_A, A2), await mkNamed(`Sandalia ${tag} azul`, ORG_A, A2)];

      const narrowed = idsIn(await products.findFamilySuggestions(ORG_A, A1));
      expect(narrowed).toEqual(expect.arrayContaining(inA1));
      for (const id of inA2) expect(narrowed).not.toContain(id);

      // And the company-wide reader still sees both branches.
      const wide = idsIn(await products.findFamilySuggestions(ORG_A, undefined));
      expect(wide).toEqual(expect.arrayContaining([...inA1, ...inA2]));
    });

    it('cannot reach another company by naming one of its branches', async () => {
      const tag = tagFor();
      const theirs = await mkNamed(`Gorro ${tag} roja`, ORG_B, B1);
      await mkNamed(`Gorro ${tag} azul`, ORG_B, B1);
      // Company A, narrowed to a store that belongs to company B: the company
      // clause decides, so the answer is empty rather than company B's.
      const crossed = idsIn(await products.findFamilySuggestions(ORG_A, B1));
      expect(crossed).not.toContain(theirs);
      expect(crossed).toEqual([]);
    });
  });

  describe('what a refusal is allowed to say', () => {
    it('reports reasons as codes, never as text carrying another tenant name', async () => {
      const tag = tagFor();
      await mkNamed(`Abrigo ${tag} roja`, ORG_A, A1);
      await mkNamed(`Abrigo ${tag} azul`, ORG_A, null);

      const group = (await products.findFamilySuggestions(ORG_A, undefined)).find((s) =>
        s.name.toLowerCase().includes(tag),
      );
      expect(group!.readiness).toBe('BLOCKED');
      for (const reason of group!.blockedReasons) expect(SUGGESTION_BLOCKED_REASONS).toContain(reason);
    });

    it('exposes no organization or store identifier on a member', async () => {
      const tag = tagFor();
      await mkNamed(`Guante ${tag} roja`, ORG_A, A1);
      await mkNamed(`Guante ${tag} azul`, ORG_A, A1);
      const group = (await products.findFamilySuggestions(ORG_A, undefined)).find((s) =>
        s.name.toLowerCase().includes(tag),
      );
      const keys = Object.keys(group!.members[0]);
      expect(keys.sort()).toEqual(['hasSpecificationConflict', 'hasStore', 'id', 'label', 'name', 'price', 'status']);
      // `hasStore` is a BOOLEAN on purpose: which shop an item is in is not
      // this endpoint's business, and naming one would say more than the
      // reader asked.
      expect(typeof group!.members[0].hasStore).toBe('boolean');
    });
  });
});
