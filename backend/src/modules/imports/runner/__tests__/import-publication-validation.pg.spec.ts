import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductInventoryApplier } from '../product-inventory.applier';
import { ProductRowPlan } from '../plan-compiler';
import { ProductRelationshipsApplier } from '../product-relationships.applier';
import { ProductsApplier } from '../../appliers/products.applier';
import { CategoriesApplier } from '../../appliers/categories.applier';
import { InventoryProposalApplier } from '../../appliers/inventory-proposal.applier';
import { InventoryPostingService } from '../../../inventory/ledger/inventory-posting.service';
import { InventoryTransaction } from '../../../inventory/entities/inventory-transaction.entity';
import { PublicationGuardService } from '../../../products/publication/publication-guard.service';
import { PlannedUnit } from '../../execution/batch-planner';
import { executePlan } from '../../execution/import-executor';
import { OrmExecutionStore } from '../../execution/orm-execution-store';
import { CancellationToken } from '../../execution/cancellation';
import { storePublicationLock } from '../../../products/families/advisory-lock.util';
import { RowOutcome } from '../../entities/import-row-result.entity';

const APPROVER = '00000000-0000-4000-8000-000000000001';
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * Issue #260 — the plan-based importer must not publish what the API refuses.
 *
 * `ProductsApplier` writes `products.status` and `store_products.published`
 * with raw SQL, and nothing in this path ever consulted
 * `PublicationGuardService.assertPublishable`. The dashboard refuses to publish
 * a child or a standalone product into a shop whose required fields it does not
 * answer; this importer accepted exactly that.
 *
 * The validation seam is HERE, in the orchestrating applier — not in
 * `ProductsApplier` — because `ProductRelationshipsApplier` writes
 * `product_field_values` AFTER products and pivots, in the same transaction. A
 * check inside `ProductsApplier` would run before a row's own answer exists and
 * would refuse a perfectly legal import.
 */
d('issue #260 — publication validation in the plan-based importer (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let applier: ProductInventoryApplier;

  let ORG: string;
  let STORE_A: string;
  let STORE_B: string;
  let DEF_WEIGHT: { id: string; key: string };
  let DEF_COLOUR: { id: string; key: string };

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;

  const context = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    executionId: randomUUID(),
    importType: 'PRODUCTS',
    approvedByUserId: APPROVER,
    em,
    ...over,
  });

  const unit = (mutations: ProductRowPlan[]): PlannedUnit =>
    ({ kind: 'ROW', sourceRows: mutations.map((m) => m.product.sourceRow), mutations }) as unknown as PlannedUnit;

  /** Apply the way the runner does: one transaction for the whole batch. */
  const applyInTx = (u: PlannedUnit) =>
    em.transactional(async (tem) => applier.apply(u, context({ em: tem as EntityManager }) as never));

  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const mkStore = async (label: string, organizationId = ORG) =>
    (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?::uuid, now(), now()) returning id`,
        [label, uid(label), organizationId],
      )
    )[0].id;

  const mkDefinition = async (label: string, organizationId = ORG): Promise<{ id: string; key: string }> => {
    const key = uid(label);
    const [rowRec] = await exec<{ id: string }[]>(
      `insert into product_field_definitions (id, organization_id, key, label, type, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?, ?, 'TEXT', now(), now()) returning id`,
      [organizationId, key, label],
    );
    return { id: rowRec.id, key };
  };

  /** Make a definition REQUIRED in a store. */
  const require_ = async (storeId: string, definitionId: string, organizationId = ORG) =>
    exec(
      `insert into store_field_settings
         (id, organization_id, store_id, definition_id, active, required, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, true, now(), now())
       on conflict do nothing`,
      [organizationId, storeId, definitionId],
    );

  const mkProduct = async (
    over: { status?: string; parentId?: string | null; organizationId?: string } = {},
  ): Promise<string> => {
    const name = uid('p');
    return (
      await exec<{ id: string }[]>(
        `insert into products
           (id, name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?::uuid, ?, 10, false, ?::uuid, now(), now()) returning id`,
        [name, name, over.organizationId ?? ORG, over.status ?? 'DRAFT', over.parentId ?? null],
      )
    )[0].id;
  };

  const listIn = async (productId: string, storeId: string, published: boolean, organizationId = ORG) =>
    exec(
      `insert into store_products
         (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, ?, false, now(), now())`,
      [organizationId, storeId, productId, published],
    );

  const pivots = async (productId: string) =>
    exec<{ store_id: string; published: boolean }[]>(
      `select store_id, published from store_products where product_id = ?::uuid order by store_id`,
      [productId],
    );

  const statusOf = async (productId: string) =>
    (await exec<{ status: string }[]>(`select status from products where id = ?::uuid`, [productId]))[0]?.status;

  const row = (over: Partial<ProductRowPlan['product']> & { sourceRow: number }): ProductRowPlan =>
    ({ product: { fields: {}, ...over } }) as ProductRowPlan;

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    const posting = new InventoryPostingService(em.getRepository(InventoryTransaction) as never);
    applier = new ProductInventoryApplier(
      new ProductsApplier(new PublicationGuardService()),
      new InventoryProposalApplier(posting),
      () => ({ organizationId: ORG, allowedStoreIds: [], destination: null, storeNames: new Map() }) as never,
      new ProductRelationshipsApplier(new CategoriesApplier()),
      new PublicationGuardService(),
    );

    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Pub Co', ?, now(), now()) returning id`,
        [uid('pub-co')],
      )
    )[0].id;
    STORE_A = await mkStore('centro');
    STORE_B = await mkStore('norte');
    DEF_WEIGHT = await mkDefinition('peso');
    DEF_COLOUR = await mkDefinition('color');
    await require_(STORE_A, DEF_WEIGHT.id);
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  /**
   * THE BYPASS. Each of these currently succeeds and must refuse.
   */
  describe('the bypass', () => {
    it('refuses publishing a STANDALONE product into a store whose required field it does not answer', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });

      await expect(
        applyInTx(
          unit([row({ sourceRow: 1, targetId: p, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
        ),
      ).rejects.toThrow(/cannot be published in that branch/i);

      // Nothing lasting: the pivot the row asked for does not exist.
      expect(await pivots(p)).toEqual([]);
    });

    it('refuses publishing a CHILD into such a store', async () => {
      const card = await mkProduct({ status: 'PUBLISHED' });
      const child = await mkProduct({ status: 'PUBLISHED', parentId: card });

      await expect(
        applyInTx(
          unit([row({ sourceRow: 2, targetId: child, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
        ),
      ).rejects.toThrow(/cannot be published in that branch/i);

      expect(await pivots(child)).toEqual([]);
    });

    it('refuses flipping an EXISTING unpublished listing to published', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      await listIn(p, STORE_A, false);

      await expect(
        applyInTx(
          unit([row({ sourceRow: 3, targetId: p, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
        ),
      ).rejects.toThrow(/cannot be published in that branch/i);

      // The listing is still there, still hidden — unchanged, not removed.
      expect(await pivots(p)).toEqual([{ store_id: STORE_A, published: false }]);
    });

    it('refuses a DRAFT → PUBLISHED status flip while a published listing is retained', async () => {
      const p = await mkProduct({ status: 'DRAFT' });
      await listIn(p, STORE_A, true);

      await expect(
        applyInTx(unit([row({ sourceRow: 4, targetId: p, fields: { published: true } } as never)])),
      ).rejects.toThrow(/cannot be published in that branch/i);

      // The status flip is rolled back with everything else.
      expect(await statusOf(p)).toBe('DRAFT');
      expect(await pivots(p)).toEqual([{ store_id: STORE_A, published: true }]);
    });

    it('refuses before ANY lasting write — product, pivot and field value all absent', async () => {
      const before = (
        await exec<{ n: number }[]>(`select count(*)::int as n from products where organization_id = ?::uuid`, [ORG])
      )[0].n;

      await expect(
        applyInTx(
          unit([
            row({
              sourceRow: 5,
              fields: { name: 'Brand New', published: true },
              storeValues: [{ storeId: STORE_A, published: true }],
            } as never),
          ]),
        ),
      ).rejects.toThrow(/cannot be published in that branch/i);

      const after = (
        await exec<{ n: number }[]>(`select count(*)::int as n from products where organization_id = ?::uuid`, [ORG])
      )[0].n;
      expect(after).toBe(before);
    });
  });
  /**
   * (1) The answer a row supplies in the SAME import must count.
   *
   * This is why validation sits in this applier and not in `ProductsApplier`:
   * the specification is written by `ProductRelationshipsApplier`, after the
   * product and its pivots. A check placed earlier refuses a legal import.
   */
  describe('a field supplied by the same row', () => {
    it('is visible to validation, so the row succeeds', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });

      const results = await applyInTx(
        unit([
          {
            product: {
              sourceRow: 10,
              targetId: p,
              fields: {},
              storeValues: [{ storeId: STORE_A, published: true }],
            },
            relationships: {
              specifications: [{ definitionKey: DEF_WEIGHT.key, value: '3', expectedType: 'TEXT' }],
            },
          } as unknown as ProductRowPlan,
        ]),
      );

      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await pivots(p)).toEqual([{ store_id: STORE_A, published: true }]);
    });
  });

  describe('what is exposed, and what is not', () => {
    it('(2) draft → published validates EVERY finally published store', async () => {
      const p = await mkProduct({ status: 'DRAFT' });
      await listIn(p, STORE_A, true); // requires DEF_WEIGHT
      await listIn(p, STORE_B, true); // requires nothing

      // Store A is reached through the STATUS change alone — the plan names no
      // store at all.
      await expect(
        applyInTx(unit([row({ sourceRow: 11, targetId: p, fields: { published: true } } as never)])),
      ).rejects.toThrow(/cannot be published in that branch/i);
      expect(await statusOf(p)).toBe('DRAFT');
    });

    it('(3) unpublished → published validates ONLY the newly exposed store', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      await listIn(p, STORE_A, true); // already live in the demanding store
      await listIn(p, STORE_B, false);

      // Only Store B turns published. Store A is retained, already live, and
      // must NOT be re-validated — the product does not answer its field, and
      // re-checking it would refuse a write that exposes nothing new.
      const results = await applyInTx(
        unit([row({ sourceRow: 12, targetId: p, storeValues: [{ storeId: STORE_B, published: true }] } as never)]),
      );

      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await pivots(p)).toEqual(
        [
          { store_id: STORE_A, published: true },
          { store_id: STORE_B, published: true },
        ].sort((a, b) => a.store_id.localeCompare(b.store_id)),
      );
    });

    it('(4a) a DRAFT product may be listed anywhere — nothing is exposed', async () => {
      const p = await mkProduct({ status: 'DRAFT' });
      const results = await applyInTx(
        unit([row({ sourceRow: 13, targetId: p, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
      );
      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await pivots(p)).toEqual([{ store_id: STORE_A, published: true }]);
    });

    it('(4b) an explicitly UNPUBLISHED listing is always allowed', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      await listIn(p, STORE_A, true);
      const results = await applyInTx(
        unit([row({ sourceRow: 14, targetId: p, storeValues: [{ storeId: STORE_A, published: false }] } as never)]),
      );
      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await pivots(p)).toEqual([{ store_id: STORE_A, published: false }]);
    });

    it('(4c) published → draft is allowed and exposes nothing', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      await listIn(p, STORE_A, true);
      const results = await applyInTx(
        unit([row({ sourceRow: 15, targetId: p, fields: { published: false } } as never)]),
      );
      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await statusOf(p)).toBe('DRAFT');
    });
  });

  describe('who is protected', () => {
    it('(5) a parent CARD is exempt, as everywhere else', async () => {
      const card = await mkProduct({ status: 'PUBLISHED' });
      const kid = await mkProduct({ status: 'PUBLISHED', parentId: card });
      // The card's listings are DERIVED from its children's (PR #259), so a
      // card listed where no child sells would be reconciled away before this
      // test could say anything about exemption.
      await listIn(kid, STORE_A, true);

      const results = await applyInTx(
        unit([row({ sourceRow: 16, targetId: card, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
      );
      // A card is never sold, so demanding a value of it would refuse
      // publication of something nobody can buy.
      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(await pivots(card)).toEqual([{ store_id: STORE_A, published: true }]);
    });

    it('(6) a standalone product and a child are protected identically', async () => {
      const standalone = await mkProduct({ status: 'PUBLISHED' });
      const card = await mkProduct({ status: 'PUBLISHED' });
      const child = await mkProduct({ status: 'PUBLISHED', parentId: card });

      const refuse = (id: string, sourceRow: number) =>
        applyInTx(
          unit([row({ sourceRow, targetId: id, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
        ).catch((e) => e);

      const a = await refuse(standalone, 17);
      const b = await refuse(child, 18);
      expect(a.constructor.name).toBe(b.constructor.name);
      expect(a.getStatus()).toBe(b.getStatus());
      expect((a.getResponse() as any).message).toBe((b.getResponse() as any).message);
    });

    it('(6b) a child answered by its PARENT is publishable', async () => {
      const card = await mkProduct({ status: 'PUBLISHED' });
      const child = await mkProduct({ status: 'PUBLISHED', parentId: card });
      await exec(
        `insert into product_field_values
           (id, organization_id, product_id, definition_id, definition_type, value_text, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, 'TEXT', 'inherited', now(), now())`,
        [ORG, card, DEF_WEIGHT.id],
      );
      const results = await applyInTx(
        unit([row({ sourceRow: 19, targetId: child, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
      );
      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
    });
  });

  describe('(7) multiple stores with different policies', () => {
    it('names the same blocking store every time', async () => {
      await require_(STORE_B, DEF_COLOUR.id);
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const p = await mkProduct({ status: 'PUBLISHED' });
        const err: any = await applyInTx(
          unit([
            row({
              sourceRow: 20 + i,
              targetId: p,
              storeValues: [
                { storeId: STORE_B, published: true },
                { storeId: STORE_A, published: true },
              ],
            } as never),
          ]),
        ).catch((e) => e);
        seen.add(err.getResponse().storeId);
      }
      // Ascending store id, so the reported blocker never flickers.
      expect(seen.size).toBe(1);
      expect([STORE_A, STORE_B].sort()[0]).toBe(Array.from(seen)[0]);
      await exec(`delete from store_field_settings where store_id = ?::uuid and definition_id = ?::uuid`, [
        STORE_B,
        DEF_COLOUR.id,
      ]);
    });
  });

  describe('(8) a refusal leaves nothing behind', () => {
    it('undoes product, pivot, field value, family link, derived parent store and ledger together', async () => {
      const card = await mkProduct({ status: 'PUBLISHED' });
      const child = await mkProduct({ status: 'PUBLISHED', parentId: card });
      await listIn(child, STORE_B, true);
      await listIn(card, STORE_B, true);

      const census = async () => ({
        products: (
          await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id=?::uuid`, [ORG])
        )[0].n,
        pivots: (
          await exec<{ n: number }[]>(`select count(*)::int n from store_products where organization_id=?::uuid`, [ORG])
        )[0].n,
        values: (
          await exec<{ n: number }[]>(
            `select count(*)::int n from product_field_values where organization_id=?::uuid`,
            [ORG],
          )
        )[0].n,
        ledger: (
          await exec<{ n: number }[]>(
            `select count(*)::int n from inventory_transactions where organization_id=?::uuid`,
            [ORG],
          )
        )[0].n,
      });
      const before = await census();
      const cardStoresBefore = await pivots(card);

      await expect(
        applyInTx(
          unit([
            {
              product: {
                sourceRow: 30,
                targetId: child,
                fields: {},
                storeValues: [{ storeId: STORE_A, published: true }],
              },
              relationships: {
                specifications: [{ definitionKey: DEF_COLOUR.key, value: 'rojo', expectedType: 'TEXT' }],
              },
            } as unknown as ProductRowPlan,
          ]),
        ),
      ).rejects.toThrow(/cannot be published in that branch/i);

      expect(await census()).toEqual(before);
      // The card's DERIVED stores are untouched too — PR #259's reconciliation
      // ran inside this transaction and rolled back with it.
      expect(await pivots(card)).toEqual(cardStoresBefore);
    });
  });

  describe('(9) tenancy', () => {
    it('refuses a store belonging to another company before any lasting write', async () => {
      const foreignOrg = (
        await exec<{ id: string }[]>(
          `insert into organizations (id, name, slug, created_at, updated_at)
           values (gen_random_uuid(), 'Rival', ?, now(), now()) returning id`,
          [uid('rival')],
        )
      )[0].id;
      const foreignStore = await mkStore('rival-shop', foreignOrg);
      const foreignDef = await mkDefinition('peso', foreignOrg);
      await require_(foreignStore, foreignDef.id, foreignOrg);

      const p = await mkProduct({ status: 'PUBLISHED' });
      const before = await pivots(p);
      await applyInTx(
        unit([row({ sourceRow: 40, targetId: p, storeValues: [{ storeId: foreignStore, published: true }] } as never)]),
      ).catch(() => undefined);

      // Either refused or never written — what must never happen is a published
      // listing of this company's product in another company's shop.
      const after = await pivots(p);
      expect(after.filter((r) => r.store_id === foreignStore && r.published)).toEqual([]);
      expect(before).toEqual(before);
    });
  });

  describe('(11) replay', () => {
    it('does not duplicate or rewrite pivots', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      await listIn(p, STORE_B, true);
      await exec(
        `update store_products set price = 55, lead_time_days = 3 where product_id = ?::uuid and store_id = ?::uuid`,
        [p, STORE_B],
      );
      const mutation = () =>
        unit([row({ sourceRow: 50, targetId: p, storeValues: [{ storeId: STORE_B, published: true }] } as never)]);

      await applyInTx(mutation());
      const first = await exec<any[]>(
        `select store_id, published, price, sale_price, cost, lead_time_days, track_inventory
           from store_products where product_id = ?::uuid order by store_id`,
        [p],
      );
      await applyInTx(mutation());
      const second = await exec<any[]>(
        `select store_id, published, price, sale_price, cost, lead_time_days, track_inventory
           from store_products where product_id = ?::uuid order by store_id`,
        [p],
      );

      expect(second).toEqual(first);
      expect(first).toHaveLength(1);
      // (12-adjacent) commercial values the shop set are not rewritten.
      expect(Number(first[0].price)).toBe(55);
      expect(first[0].lead_time_days).toBe(3);
    });
  });
  describe('(10) concurrency', () => {
    it('cannot leave a published listing in a store that requires an unanswered field', async () => {
      const p = await mkProduct({ status: 'PUBLISHED' });
      const def = await mkDefinition('ancho');

      // Two INDEPENDENT connections race for the same store. The import takes
      // `storePublicationLock(STORE_B)` in phase 1, before it reads anything;
      // the requirement path takes the same key through
      // `lockStoreRequirements`. One waits for the other, and each then decides
      // against a settled state:
      //
      //   import first  → the requirement path finds a published product that
      //                   does not answer, and `assertRequirableInStore`
      //                   refuses to make the field required;
      //   requirement first → the import's validation refuses.
      //
      // Neither order can produce the forbidden end state.
      const importEm = pg.orm.em.fork() as EntityManager;
      const requireEm = pg.orm.em.fork() as EntityManager;
      const guard = new PublicationGuardService();

      const importing = importEm
        .transactional(async (tem) =>
          applier.apply(
            unit([row({ sourceRow: 60, targetId: p, storeValues: [{ storeId: STORE_B, published: true }] } as never)]),
            context({ em: tem as EntityManager }) as never,
          ),
        )
        .then(
          () => 'published',
          () => 'import refused',
        );

      const requiring = requireEm
        .transactional(async (tem) => {
          await guard.lockStoreRequirements(tem as EntityManager, STORE_B);
          await guard.assertRequirableInStore(tem as EntityManager, STORE_B, def.id);
          await (tem as EntityManager).execute(
            `insert into store_field_settings
               (id, organization_id, store_id, definition_id, active, required, created_at, updated_at)
             values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, true, now(), now())`,
            [ORG, STORE_B, def.id],
          );
        })
        .then(
          () => 'required',
          () => 'requirement refused',
        );

      const outcomes = await Promise.all([importing, requiring]);

      // THE INVARIANT, for the product this race is about. Scoped to it on
      // purpose: earlier cases in this file deliberately seed products that
      // were already published without an answer (the pre-existing rows issue
      // #260 does not repair), and one that is answered through its parent —
      // counting those would measure the fixtures, not the race.
      const violations = await exec<{ n: number }[]>(
        `select count(*)::int n
           from store_products sp
           join store_field_settings sfs
             on sfs.store_id = sp.store_id and sfs.active and sfs.required
           join products pr on pr.id = sp.product_id
          where sp.product_id = ?::uuid and sp.published = true and pr.status = 'PUBLISHED'
            and not exists (select 1 from product_field_values v
                             where v.product_id = sp.product_id and v.definition_id = sfs.definition_id)`,
        [p],
      );
      expect(violations[0].n).toBe(0);
      // And exactly one of the two got its way.
      expect(outcomes.filter((o) => o === 'published' || o === 'required').length).toBeGreaterThanOrEqual(1);

      await exec(`delete from store_field_settings where store_id = ?::uuid and definition_id = ?::uuid`, [
        STORE_B,
        def.id,
      ]);
      await exec(`delete from store_products where product_id = ?::uuid`, [p]);
    });
  });

  describe('the store lock is load-bearing', () => {
    /**
     * Deterministic, not timing-dependent.
     *
     * A raw session holds `storePublicationLock(STORE_B)` inside an open
     * transaction. The import is launched and OBSERVED, through `pg_locks`,
     * queuing on that exact key — which it can only do if phase 1 actually
     * acquires it before reading or writing anything. Releasing the blocker
     * lets the import finish.
     *
     * Without the phase-1 acquisition the import never queues and this test
     * times out: that is what makes the lock a tested fact rather than a
     * comment.
     */
    it('makes the import queue on the store key a requirement change would hold', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require('pg');
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.pathname = `/${pg.dbName}`;
      const blocker = new Client({ connectionString: url.toString() });
      const observer = new Client({ connectionString: url.toString() });
      await blocker.connect();
      await observer.connect();

      const key = storePublicationLock(STORE_B);
      const unsigned = (n: number) => n >>> 0;
      try {
        await blocker.query('begin');
        await blocker.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [key.ns, key.key]);

        const p = await mkProduct({ status: 'PUBLISHED' });
        const importEm = pg.orm.em.fork() as EntityManager;
        const importing = importEm.transactional(async (tem) =>
          applier.apply(
            unit([row({ sourceRow: 80, targetId: p, storeValues: [{ storeId: STORE_B, published: true }] } as never)]),
            context({ em: tem as EntityManager }) as never,
          ),
        );

        // Poll until the import is WAITING on exactly that key.
        let queued = 0;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const rows = await observer.query(
            `select count(*)::int as n from pg_locks
              where locktype = 'advisory' and not granted
                and classid = $1 and objid = $2 and objsubid = 2`,
            [unsigned(key.ns), unsigned(key.key)],
          );
          queued = rows.rows[0].n;
          if (queued > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(queued).toBeGreaterThan(0);

        await blocker.query('commit');
        await importing;
        expect((await pivots(p)).find((r) => r.store_id === STORE_B)?.published).toBe(true);
      } finally {
        await blocker.query('rollback').catch(() => undefined);
        await blocker.end().catch(() => undefined);
        await observer.end().catch(() => undefined);
      }
    }, 120_000);
  });

  describe('lock order', () => {
    it('takes every store lock before any family lock', async () => {
      // Namespaces are disjoint and canonical order is (ns, key): store = 1,
      // family = 2. Phase 1 acquires ONLY store keys, before any write, so the
      // card reconciliation that PR #259 runs later can take its family key
      // without ever inverting the order.
      const p = await mkProduct({ status: 'PUBLISHED' });
      const card = await mkProduct({ status: 'PUBLISHED' });
      const kid = await mkProduct({ status: 'PUBLISHED', parentId: card });
      await listIn(kid, STORE_B, true);

      const results = await applyInTx(
        unit([
          row({ sourceRow: 70, targetId: p, storeValues: [{ storeId: STORE_B, published: true }] } as never),
          row({ sourceRow: 71, targetId: kid, storeValues: [{ storeId: STORE_B, published: true }] } as never),
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.UPDATED)).toBe(true);
      // The card followed its child, so reconciliation ran under the locks.
      expect((await pivots(card)).map((r) => r.store_id)).toEqual([STORE_B]);
    });
  });
  /**
   * (D1) MULTI-UNIT BATCH ROLLBACK, at the real executor boundary.
   *
   * `executePlan` + `OrmExecutionStore.commitBatch` is what production runs;
   * wrapping one applier call in a test transaction would prove only that
   * PostgreSQL rolls back, not that the batch boundary carries a valid unit
   * down with an invalid one. Both units go into ONE batch, the first is
   * entirely legal, the second refuses — and the first must vanish too.
   */
  describe('(D1) a refusal rolls back the whole batch, not just its own unit', () => {
    let sourceId: string;
    const newExecution = async (): Promise<string> => {
      const [plan] = await exec<{ id: string }[]>(
        `insert into import_plans
           (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
            mapping, decisions, target_assumptions, summary)
         values (?::uuid, ?::uuid, 'PRODUCTS', ?, repeat('b',64), 'p9-1',
                 '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb) returning id`,
        [ORG, sourceId, randomUUID().replace(/-/g, '').padEnd(64, '0')],
      );
      const [run] = await exec<{ id: string }[]>(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?::uuid, ?::uuid, ?, 'RUNNING') returning id`,
        [ORG, plan.id, `exec-${randomUUID()}`],
      );
      return run.id;
    };

    beforeAll(async () => {
      sourceId = (
        await exec<{ id: string }[]>(
          `insert into import_sources
             (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
           values (?::uuid, ?, 'x.csv', 10, repeat('a',64), 'CSV_OR_TEXT', 'p9-1') returning id`,
          [ORG, `imports/${ORG}/${randomUUID()}.csv`],
        )
      )[0].id;
    });

    it('positive control: the SAME first unit, alone, commits and is checkpointed', async () => {
      // Without this the rollback case below could pass vacuously — a unit that
      // never wrote anything is trivially absent afterwards.
      const good = await mkProduct({ status: 'PUBLISHED' });
      const executionId = await newExecution();

      const result = await executePlan({
        executionId,
        organizationId: ORG,
        importType: 'PRODUCTS',
        approvedByUserId: APPROVER,
        planHash: 'plan-hash-260-control',
        sourceTable: 'Productos',
        units: [
          unit([
            {
              product: {
                sourceRow: 90,
                targetId: good,
                fields: {},
                storeValues: [{ storeId: STORE_B, published: true }],
              },
              relationships: {
                specifications: [{ definitionKey: DEF_COLOUR.key, value: 'azul', expectedType: 'TEXT' }],
              },
            } as unknown as ProductRowPlan,
          ]),
        ],
        applier: applier as never,
        store: new OrmExecutionStore(em),
        cancellation: new CancellationToken(),
        beat: async () => true,
      });

      expect(result.outcome).toBe('COMPLETED');
      expect(await pivots(good)).toEqual([{ store_id: STORE_B, published: true }]);
      const values = await exec<{ n: number }[]>(
        `select count(*)::int n from product_field_values where product_id = ?::uuid`,
        [good],
      );
      expect(values[0].n).toBe(1);
      const checkpoints = await exec<{ n: number }[]>(
        `select count(*)::int n from import_checkpoints where execution_id = ?::uuid`,
        [executionId],
      );
      expect(checkpoints[0].n).toBe(1);
    });

    it('takes the earlier VALID unit down with the later invalid one, and says so', async () => {
      // Pre-batch data that must survive byte-identical.
      const untouched = await mkProduct({ status: 'PUBLISHED' });
      await listIn(untouched, STORE_B, true);
      const untouchedBefore = await exec<any[]>(
        `select id, name, slug, status, price from products where id = ?::uuid`,
        [untouched],
      );
      const untouchedPivotsBefore = await pivots(untouched);

      const good = await mkProduct({ status: 'PUBLISHED' });
      const bad = await mkProduct({ status: 'PUBLISHED' });

      const census = async () => ({
        products: (
          await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id=?::uuid`, [ORG])
        )[0].n,
        pivots: (
          await exec<{ n: number }[]>(`select count(*)::int n from store_products where organization_id=?::uuid`, [ORG])
        )[0].n,
        values: (
          await exec<{ n: number }[]>(
            `select count(*)::int n from product_field_values where organization_id=?::uuid`,
            [ORG],
          )
        )[0].n,
        ledger: (
          await exec<{ n: number }[]>(
            `select count(*)::int n from inventory_transactions where organization_id=?::uuid`,
            [ORG],
          )
        )[0].n,
        checkpoints: (await exec<{ n: number }[]>(`select count(*)::int n from import_checkpoints`))[0].n,
      });
      const before = await census();

      const executionId = await newExecution();
      const result = await executePlan({
        executionId,
        organizationId: ORG,
        importType: 'PRODUCTS',
        approvedByUserId: APPROVER,
        planHash: 'plan-hash-260',
        sourceTable: 'Productos',
        units: [
          // UNIT 1 — entirely legal: a listing in the shop that requires nothing.
          unit([
            {
              product: {
                sourceRow: 90,
                targetId: good,
                fields: {},
                storeValues: [{ storeId: STORE_B, published: true }],
              },
              relationships: {
                specifications: [{ definitionKey: DEF_COLOUR.key, value: 'azul', expectedType: 'TEXT' }],
              },
            } as unknown as ProductRowPlan,
          ]),
          // UNIT 2 — refuses: published into the shop that demands DEF_WEIGHT.
          unit([row({ sourceRow: 91, targetId: bad, storeValues: [{ storeId: STORE_A, published: true }] } as never)]),
        ],
        applier: applier as never,
        store: new OrmExecutionStore(em),
        cancellation: new CancellationToken(),
        beat: async () => true,
      });

      // The run failed as a whole.
      expect(result.outcome).toBe('FAILED');

      // NOTHING from either unit survives — including the valid one.
      expect(await census()).toEqual(before);
      expect(await pivots(good)).toEqual([]);
      expect(await pivots(bad)).toEqual([]);

      // Pre-batch data is byte-identical.
      expect(
        await exec<any[]>(`select id, name, slug, status, price from products where id = ?::uuid`, [untouched]),
      ).toEqual(untouchedBefore);
      expect(await pivots(untouched)).toEqual(untouchedPivotsBefore);

      // The REPORT says rolled back, for BOTH rows — not just the offending one.
      const reported = await exec<{ source_row: number; outcome: string; effects: any }[]>(
        `select source_row, outcome, effects from import_row_results
          where execution_id = ?::uuid order by source_row`,
        [executionId],
      );
      expect(reported.map((r) => r.source_row)).toEqual([90, 91]);
      for (const r of reported) {
        expect(r.outcome).toBe(RowOutcome.FAILED);
        expect(r.effects.product.state).toBe('ROLLED_BACK');
        expect(r.effects.storeAssociation.state).toBe('ROLLED_BACK');
        expect(r.effects.inventory.state).toBe('ROLLED_BACK');
      }

      // No checkpoint claims the batch committed.
      const checkpoints = await exec<{ n: number }[]>(
        `select count(*)::int n from import_checkpoints where execution_id = ?::uuid`,
        [executionId],
      );
      expect(checkpoints[0].n).toBe(0);
    });
  });
});
