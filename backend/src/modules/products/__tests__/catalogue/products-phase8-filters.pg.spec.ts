import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { prepareLedger } from '../../../../../test/inventory-stock-support';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Product } from '../../entities/product.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * Phase 8 C — the two filters that must answer from the TRUTH, not a proxy.
 *
 * `sellable` answers from the AVAILABLE ledger with the owned column only as
 * the pre-epoch fallback (P5-B7's displayed rule) — so a product the company
 * OWNS but cannot sell is found, and one the owned column says nothing about
 * but the ledger can sell is not lost. `complete` asks the publication
 * guard's own question in SQL, and the guard itself is called on every
 * fixture to prove the two never disagree.
 */
d('Phase 8 catalogue filters (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let guard: PublicationGuardService;

  const service = (scoped: EntityManager) =>
    new ProductsService(
      scoped.getRepository(Product) as any,
      { find: async () => [], findOne: async () => null } as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnedWordsFor: async () => [], dismissedSignaturesFor: async () => [] } as any,
      new PublicationGuardService(),
      {} as any,
      realStock(scoped as any),
    );

  const listIds = async (filters: Record<string, unknown>, organizationId: string) => {
    const result = await service(em).findAll({ organizationId, limit: 100, ...filters } as any);
    return new Set((result.items as { id: string }[]).map((item) => item.id));
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    guard = new PublicationGuardService();
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const makeOrg = async (label: string) => {
    const suffix = `${label}-${Math.random().toString(16).slice(2, 8)}`;
    const org = em.create(Organization, { name: suffix, slug: suffix } as any);
    const store = em.create(Store, { name: `s-${suffix}`, slug: `s-${suffix}`, organization: org } as any);
    em.persist([org, store]);
    await em.flush();
    const loc = await prepareLedger(em, { organizationId: org.id, storeId: store.id });
    return { org, store, ...loc };
  };

  const makeProduct = async (org: Organization, slug: string, over: Record<string, unknown> = {}) => {
    const product = em.create(Product, {
      name: slug,
      slug: `${slug}-${Math.random().toString(16).slice(2, 6)}`,
      price: 10,
      trackInventory: true,
      stockQuantity: 0,
      status: ProductStatus.PUBLISHED,
      organization: org,
      ...over,
    } as any);
    em.persist(product);
    await em.flush();
    return product;
  };

  const putBalance = async (
    organizationId: string,
    productId: string,
    locationId: string,
    state: string,
    quantity: number,
  ) => {
    await em.transactional(async (tem) => {
      // The projection guard admits only flagged transactions; the flag is
      // transaction-local, exactly as the posting service sets it.
      await tem.execute(`select set_config('cataloguer.posting', 'on', true)`);
      await tem.execute(
        `insert into inventory_balances
           (organization_id, product_id, location_id, physical_condition, operational_state, quantity, updated_at)
         values (?::uuid, ?::uuid, ?::uuid, 'GOOD', ?, ?, now())`,
        [organizationId, productId, locationId, state, quantity],
      );
    });
  };

  describe('sellable — the ledger speaks, the owned column only as fallback', () => {
    it('separates what is owned from what can be sold, in both directions', async () => {
      const { org, warehouseId } = await makeOrg('sell');

      // Owned column says NOTHING, the ledger says three units: sellable.
      const ledgerSaysYes = await makeProduct(org, 'ledger-yes', { stockQuantity: 0 });
      await putBalance(org.id, ledgerSaysYes.id, warehouseId, 'AVAILABLE', 3);

      // Owned column says FIFTY, the ledger says every unit is out of
      // sellable state: not sellable. This is the pair that proves the
      // filter reads availability, not physical ownership.
      const ownedNotSellable = await makeProduct(org, 'owned-no', { stockQuantity: 50 });
      await putBalance(org.id, ownedNotSellable.id, warehouseId, 'AVAILABLE', 0);
      await putBalance(org.id, ownedNotSellable.id, warehouseId, 'NON_SELLABLE', 50);

      // No ledger at all (the organization's epoch has not reached it): the
      // owned figure is the only truth there is, and it is honoured.
      const preEpoch = await makeProduct(org, 'pre-epoch', { stockQuantity: 7 });
      const preEpochEmpty = await makeProduct(org, 'pre-epoch-empty', { stockQuantity: 0 });

      // Untracked: nothing to run out of.
      const untracked = await makeProduct(org, 'untracked', { trackInventory: false, stockQuantity: 0 });

      em.clear();
      const sellable = await listIds({ sellable: true }, org.id);
      const unsellable = await listIds({ sellable: false }, org.id);

      expect(sellable.has(ledgerSaysYes.id)).toBe(true);
      expect(sellable.has(preEpoch.id)).toBe(true);
      expect(sellable.has(untracked.id)).toBe(true);
      expect(sellable.has(ownedNotSellable.id)).toBe(false);
      expect(sellable.has(preEpochEmpty.id)).toBe(false);

      expect(unsellable.has(ownedNotSellable.id)).toBe(true);
      expect(unsellable.has(preEpochEmpty.id)).toBe(true);
      expect(unsellable.has(ledgerSaysYes.id)).toBe(false);
      expect(unsellable.has(untracked.id)).toBe(false);
    });

    it('narrowed to a branch, availability means THAT shelf', async () => {
      const { org, store, warehouseId, storeLocationId } = await makeOrg('sell-branch');
      const atWarehouse = await makeProduct(org, 'at-warehouse', { stockQuantity: 0 });
      const atBranch = await makeProduct(org, 'at-branch', { stockQuantity: 0 });
      await em.execute(
        `insert into store_products (store_id, product_id, organization_id, published, created_at, updated_at) values (?::uuid, ?::uuid, ?::uuid, true, now(), now())`,
        [store.id, atWarehouse.id, org.id],
      );
      await em.execute(
        `insert into store_products (store_id, product_id, organization_id, published, created_at, updated_at) values (?::uuid, ?::uuid, ?::uuid, true, now(), now())`,
        [store.id, atBranch.id, org.id],
      );
      await putBalance(org.id, atWarehouse.id, warehouseId, 'AVAILABLE', 4);
      await putBalance(org.id, atBranch.id, storeLocationId!, 'AVAILABLE', 2);

      em.clear();
      const companyWide = await listIds({ sellable: true }, org.id);
      expect(companyWide.has(atWarehouse.id)).toBe(true);
      expect(companyWide.has(atBranch.id)).toBe(true);

      const branchOnly = await listIds({ sellable: true, storeFilterId: store.id }, org.id);
      expect(branchOnly.has(atBranch.id)).toBe(true);
      // Four units in the warehouse do not make it sellable AT the branch.
      expect(branchOnly.has(atWarehouse.id)).toBe(false);
    });
  });

  describe('complete — the publication guard’s own predicate', () => {
    it('agrees with the guard on every fixture, inheritance included', async () => {
      const { org, store } = await makeOrg('complete');
      const [definition]: { id: string }[] = await em.execute(
        `insert into product_field_definitions (organization_id, key, label, type, applicability, created_at, updated_at)
         values (?::uuid, 'material', 'Material', 'TEXT', 'BOTH', now(), now()) returning id`,
        [org.id],
      );
      const [childOnly]: { id: string }[] = await em.execute(
        `insert into product_field_definitions (organization_id, key, label, type, applicability, created_at, updated_at)
         values (?::uuid, 'seat-height', 'Seat height', 'TEXT', 'CHILD', now(), now()) returning id`,
        [org.id],
      );
      for (const def of [definition.id, childOnly.id]) {
        await em.execute(
          `insert into store_field_settings (organization_id, store_id, definition_id, active, required, publicly_visible, importable, filterable, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, true, true, false, false, false, now(), now())`,
          [org.id, store.id, def],
        );
      }

      const assign = (productId: string) =>
        em.execute(
          `insert into store_products (store_id, product_id, organization_id, published, created_at, updated_at) values (?::uuid, ?::uuid, ?::uuid, true, now(), now())`,
          [store.id, productId, org.id],
        );
      const answer = (productId: string, definitionId: string) =>
        em.execute(
          `insert into product_field_values (organization_id, product_id, definition_id, definition_type, value_text, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, 'TEXT', 'oak', now(), now())`,
          [org.id, productId, definitionId],
        );

      // Answers everything itself.
      const answered = await makeProduct(org, 'answered');
      await assign(answered.id);
      await answer(answered.id, definition.id);
      await answer(answered.id, childOnly.id);

      // Assigned, silent: the branch demands and nothing answers.
      const silent = await makeProduct(org, 'silent');
      await assign(silent.id);

      // A version answered BY ITS MODEL — applicability BOTH lets it inherit.
      const model = await makeProduct(org, 'model');
      await answer(model.id, definition.id);
      const inheritingChild = await makeProduct(org, 'inheriting-child', { parent: model });
      await assign(inheritingChild.id);
      await answer(inheritingChild.id, childOnly.id);

      // A version whose model answered a CHILD-only field: inheritance cannot
      // apply, so the version is still incomplete.
      const orphanChild = await makeProduct(org, 'orphan-child', { parent: model });
      await assign(orphanChild.id);
      await answer(orphanChild.id, definition.id);
      await answer(model.id, childOnly.id);

      // Assigned nowhere: no branch demands anything of it.
      const unassigned = await makeProduct(org, 'unassigned');

      em.clear();
      const incomplete = await listIds({ complete: false }, org.id);
      const complete = await listIds({ complete: true }, org.id);

      const expectIncomplete = [silent.id, orphanChild.id];
      const expectComplete = [answered.id, inheritingChild.id, unassigned.id, model.id];
      for (const id of expectIncomplete) {
        expect(incomplete.has(id)).toBe(true);
        expect(complete.has(id)).toBe(false);
      }
      for (const id of expectComplete) {
        expect(complete.has(id)).toBe(true);
        expect(incomplete.has(id)).toBe(false);
      }

      // THE AGREEMENT: the guard refuses exactly the products the filter
      // calls incomplete, over each product's own assigned branches.
      const casesRefused = [silent.id, orphanChild.id];
      const casesAllowed = [answered.id, inheritingChild.id];
      for (const id of casesRefused) {
        const product = await em.findOneOrFail(Product, { id });
        await expect(
          em.transactional((tem) => guard.assertPublishable(tem as EntityManager, product, [store.id])),
        ).rejects.toThrow(/cannot be published/);
        em.clear();
      }
      for (const id of casesAllowed) {
        const product = await em.findOneOrFail(Product, { id });
        await expect(
          em.transactional((tem) => guard.assertPublishable(tem as EntityManager, product, [store.id])),
        ).resolves.toBeUndefined();
        em.clear();
      }
    });
  });
});
