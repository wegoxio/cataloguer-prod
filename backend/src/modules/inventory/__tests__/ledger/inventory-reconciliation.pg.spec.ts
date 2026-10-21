import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { seedOrganization, createProduct, SeededOrg, withCutoverFreeze } from '../../../../../test/inventory-fixtures';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryReconciliationService, INVARIANT_ACTIVATION } from '../../ledger/inventory-reconciliation.service';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { InventoryCommand, InventoryPrincipal } from '../../ledger/inventory.types';

const USER: InventoryPrincipal = { kind: 'USER', userId: '66666666-6666-4666-8666-666666666666' };

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-B1 — the reconciliation equations, and the conservation grain each command
 * type is held to.
 *
 * The cross-product compensation probe is the point of this file: a
 * transaction-level `SUM(quantity_delta) = 0` accepts "remove five of product A
 * and add five of product B", so every in-place type is attacked with exactly
 * that and must refuse it.
 */
d('P5-B1 inventory reconciliation and conservation (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let seed: SeededOrg;
  let posting: any;
  let reconciliation: InventoryReconciliationService;

  const post = (command: Partial<InventoryCommand>): Promise<any> =>
    posting.post({
      organizationId: seed.organizationId,
      idempotencyKey: `k-${Math.random()}`,
      principal: USER,
      ...command,
    } as InventoryCommand);

  /** P5-X1: an opening posts only inside a declared cutover window. */
  const opening = (productId: string, locationId: string, quantity: number) =>
    withCutoverFreeze(em, seed.organizationId, () =>
      post({
        type: 'OPENING_BALANCE',
        intents: [{ productId, declaredAmount: quantity, intentSign: 1 }],
        movements: [
          { productId, locationId, physicalCondition: 'GOOD', operationalState: 'AVAILABLE', quantityDelta: quantity },
        ],
      }),
    );

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    seed = await seedOrganization(em, 'recon');
    posting = Object.create(InventoryPostingService.prototype);
    posting.transactionRepository = em.getRepository(InventoryTransaction);
    reconciliation = Object.create(InventoryReconciliationService.prototype);
    (reconciliation as any).balanceRepository = em.getRepository(InventoryBalance);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('conservation grain per command type', () => {
    it('RESERVE conserves in place and proves HOW MUCH moved, not merely that it balanced', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      // Declares 3 but actually moves 5: net-zero alone would accept this.
      await expect(
        post({
          type: 'RESERVE',
          intents: [{ productId: product, declaredAmount: 3, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'RESERVED',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/moved 5 units but declared 3/);
    });

    it('RESERVE refuses to cross a location boundary', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await expect(
        post({
          type: 'RESERVE',
          intents: [{ productId: product, declaredAmount: 3, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: product,
              locationId: seed.storeLocationId,
              physicalCondition: 'GOOD',
              operationalState: 'RESERVED',
              quantityDelta: 3,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve per \(product, location, physicalCondition\)/);
    });

    it('RESERVE refuses to cross a condition boundary', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await expect(
        post({
          type: 'RESERVE',
          intents: [{ productId: product, declaredAmount: 3, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'DAMAGED',
              operationalState: 'RESERVED',
              quantityDelta: 3,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve per \(product, location, physicalCondition\)/);
    });

    it('ALLOCATE moves between locations while preserving condition', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await post({
        type: 'ALLOCATE',
        intents: [{ productId: product, declaredAmount: 4, intentSign: 0 }],
        movements: [
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: -4,
          },
          {
            productId: product,
            locationId: seed.storeLocationId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: 4,
          },
        ],
      });
      expect(await reconciliation.storeHeldQuantity(seed.organizationId, seed.storeId, product)).toBe(4);
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, product)).toBe(10);
    });

    it('SELLABILITY_RECLASSIFY changes condition in place but not location', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 6);
      await post({
        type: 'SELLABILITY_RECLASSIFY',
        intents: [{ productId: product, declaredAmount: 2, intentSign: 0 }],
        movements: [
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: -2,
          },
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'DAMAGED',
            operationalState: 'AVAILABLE',
            quantityDelta: 2,
          },
        ],
      });
      // Condition and state are orthogonal: DAMAGED + AVAILABLE is sellable.
      expect(await reconciliation.sellableQuantity(seed.organizationId, product)).toBe(6);
      await expect(
        post({
          type: 'SELLABILITY_RECLASSIFY',
          intents: [{ productId: product, declaredAmount: 1, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -1,
            },
            {
              productId: product,
              locationId: seed.storeLocationId,
              physicalCondition: 'DAMAGED',
              operationalState: 'AVAILABLE',
              quantityDelta: 1,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve per \(product, location\)/);
    });

    it.each([['RESERVE'], ['RELEASE'], ['ALLOCATE'], ['TRANSFER_COMMIT'], ['SELLABILITY_RECLASSIFY']])(
      '%s refuses cross-product compensation even though the transaction nets to zero',
      async (type) => {
        const productA = await createProduct(em, seed.organizationId);
        const productB = await createProduct(em, seed.organizationId);
        await opening(productA, seed.warehouseId, 10);
        await opening(productB, seed.warehouseId, 10);
        await expect(
          post({
            type: type as any,
            intents: [
              { productId: productA, declaredAmount: 5, intentSign: 0 },
              { productId: productB, declaredAmount: 5, intentSign: 0 },
            ],
            movements: [
              {
                productId: productA,
                locationId: seed.warehouseId,
                physicalCondition: 'GOOD',
                operationalState: 'AVAILABLE',
                quantityDelta: -5,
              },
              {
                productId: productB,
                locationId: seed.warehouseId,
                physicalCondition: 'GOOD',
                operationalState: 'AVAILABLE',
                quantityDelta: 5,
              },
            ],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('the 2x2 cross-swap: marginals are not enough', () => {
    /**
     * The adversarial case the earlier marginal check let through.
     *
     * Take 5 from (L1, GOOD) and 5 from (L2, DAMAGED); give 5 to (L1, DAMAGED)
     * and 5 to (L2, GOOD). Every LOCATION nets zero. Every CONDITION nets zero.
     * And yet five units changed both their location and their condition, which
     * is exactly what an in-place command must not do. Only the composite key
     * (product, location, condition) sees it.
     */
    const crossSwap = (product: string, l1: string, l2: string) => ({
      intents: [{ productId: product, declaredAmount: 10, intentSign: 0 as const }],
      movements: [
        {
          productId: product,
          locationId: l1,
          physicalCondition: 'GOOD' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: -5,
        },
        {
          productId: product,
          locationId: l2,
          physicalCondition: 'DAMAGED' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: -5,
        },
        {
          productId: product,
          locationId: l1,
          physicalCondition: 'DAMAGED' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: 5,
        },
        {
          productId: product,
          locationId: l2,
          physicalCondition: 'GOOD' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: 5,
        },
      ],
    });

    it('the swap really does satisfy both marginals — the old check would have passed it', async () => {
      const product = await createProduct(em, seed.organizationId);
      const swap = crossSwap(product, seed.warehouseId, seed.storeLocationId);
      const byLocation = new Map<string, number>();
      const byCondition = new Map<string, number>();
      for (const line of swap.movements) {
        byLocation.set(line.locationId, (byLocation.get(line.locationId) ?? 0) + line.quantityDelta);
        byCondition.set(line.physicalCondition, (byCondition.get(line.physicalCondition) ?? 0) + line.quantityDelta);
      }
      expect([...byLocation.values()]).toEqual([0, 0]);
      expect([...byCondition.values()]).toEqual([0, 0]);
    });

    it.each([['RESERVE'], ['RELEASE']])('%s refuses the 2x2 cross-swap', async (type) => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 20);
      await expect(
        post({ type: type as any, ...crossSwap(product, seed.warehouseId, seed.storeLocationId) }),
      ).rejects.toThrow(/must conserve per \(product, location, physicalCondition\)/);
    });

    /**
     * The swap is NOT universally illegal, and saying so would be sloppy. For
     * ALLOCATE the grain is (product, condition): the swap moves GOOD one way
     * and DAMAGED the other while each condition's total holds, which is a
     * legitimate two-condition relocation. For SELLABILITY_RECLASSIFY the grain
     * is (product, location) and the swap is a legitimate simultaneous
     * reclassification at two locations. What each type must refuse is a move
     * across ITS OWN grain, which is what these two prove.
     */
    it('ALLOCATE refuses a movement that changes condition', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await expect(
        post({
          type: 'ALLOCATE',
          intents: [{ productId: product, declaredAmount: 3, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: product,
              locationId: seed.storeLocationId,
              physicalCondition: 'DAMAGED',
              operationalState: 'AVAILABLE',
              quantityDelta: 3,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve per \(product, physicalCondition\)/);
    });

    it('SELLABILITY_RECLASSIFY refuses a movement that changes location', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await expect(
        post({
          type: 'SELLABILITY_RECLASSIFY',
          intents: [{ productId: product, declaredAmount: 3, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: product,
              locationId: seed.storeLocationId,
              physicalCondition: 'DAMAGED',
              operationalState: 'AVAILABLE',
              quantityDelta: 3,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve per \(product, location\)/);
    });

    it('still accepts a legitimate in-place move at one cell', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 10);
      await expect(
        post({
          type: 'RESERVE',
          intents: [{ productId: product, declaredAmount: 4, intentSign: 0 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -4,
            },
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'RESERVED',
              quantityDelta: 4,
            },
          ],
        }),
      ).resolves.toBeDefined();
      // Put them back before leaving. From P5-B4 on, a RESERVED balance is
      // expected to be accounted for by a reservation aggregate, and this suite
      // posts the raw command rather than going through that service — so
      // leaving units reserved here would look, correctly, like unaccounted
      // reserved stock to equation 8.
      await post({
        type: 'RELEASE',
        intents: [{ productId: product, declaredAmount: 4, intentSign: 0 }],
        movements: [
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'RESERVED',
            quantityDelta: -4,
          },
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: 4,
          },
        ],
      });
    });
  });

  describe('R12: the two product-changing commands have DIFFERENT contracts', () => {
    it('family distribution root -> children succeeds', async () => {
      const root = await createProduct(em, seed.organizationId);
      const childA = await createProduct(em, seed.organizationId, root);
      const childB = await createProduct(em, seed.organizationId, root);
      await opening(root, seed.warehouseId, 9);
      await expect(
        post({
          type: 'FAMILY_STOCK_DISTRIBUTION',
          scopeProductId: root,
          intents: [
            { productId: root, declaredAmount: 9, intentSign: -1 },
            { productId: childA, declaredAmount: 5, intentSign: 1 },
            { productId: childB, declaredAmount: 4, intentSign: 1 },
          ],
          movements: [
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -9,
            },
            {
              productId: childA,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
            {
              productId: childB,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 4,
            },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it('refuses child -> root distribution', async () => {
      const root = await createProduct(em, seed.organizationId);
      const child = await createProduct(em, seed.organizationId, root);
      await opening(child, seed.warehouseId, 5);
      await expect(
        post({
          type: 'FAMILY_STOCK_DISTRIBUTION',
          scopeProductId: child,
          intents: [
            { productId: child, declaredAmount: 5, intentSign: -1 },
            { productId: root, declaredAmount: 5, intentSign: 1 },
          ],
          movements: [
            {
              productId: child,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/may only distribute to children of/);
    });

    it('refuses sibling -> sibling distribution', async () => {
      const root = await createProduct(em, seed.organizationId);
      const childA = await createProduct(em, seed.organizationId, root);
      const childB = await createProduct(em, seed.organizationId, root);
      await opening(childA, seed.warehouseId, 5);
      await expect(
        post({
          type: 'FAMILY_STOCK_DISTRIBUTION',
          scopeProductId: childA,
          intents: [
            { productId: childA, declaredAmount: 5, intentSign: -1 },
            { productId: childB, declaredAmount: 5, intentSign: 1 },
          ],
          movements: [
            {
              productId: childA,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
            {
              productId: childB,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/may only distribute to children of/);
    });

    it('reassignment succeeds across two UNRELATED families in one organization', async () => {
      const familyARoot = await createProduct(em, seed.organizationId);
      const familyBRoot = await createProduct(em, seed.organizationId);
      const unrelatedChild = await createProduct(em, seed.organizationId, familyBRoot);
      await opening(familyARoot, seed.warehouseId, 6);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: familyARoot,
          intents: [
            { productId: familyARoot, declaredAmount: 6, intentSign: -1 },
            { productId: unrelatedChild, declaredAmount: 6, intentSign: 1 },
          ],
          movements: [
            {
              productId: familyARoot,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -6,
            },
            {
              productId: unrelatedChild,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 6,
            },
          ],
        }),
      ).resolves.toBeDefined();
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, unrelatedChild)).toBe(6);
    });

    it('refuses a reassignment destination in another organization', async () => {
      const source = await createProduct(em, seed.organizationId);
      const foreign = await seedOrganization(em, 'r12-foreign');
      await opening(source, seed.warehouseId, 4);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: source,
          intents: [
            { productId: source, declaredAmount: 4, intentSign: -1 },
            { productId: foreign.productId, declaredAmount: 4, intentSign: 1 },
          ],
          movements: [
            {
              productId: source,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -4,
            },
            {
              productId: foreign.productId,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 4,
            },
          ],
        }),
      ).rejects.toThrow(/must belong to the acting organization/);
    });

    it('refuses a scope product that is not the negative source', async () => {
      const source = await createProduct(em, seed.organizationId);
      const destination = await createProduct(em, seed.organizationId);
      const decoy = await createProduct(em, seed.organizationId);
      await opening(source, seed.warehouseId, 3);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: decoy,
          intents: [
            { productId: source, declaredAmount: 3, intentSign: -1 },
            { productId: destination, declaredAmount: 3, intentSign: 1 },
          ],
          movements: [
            {
              productId: source,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: destination,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 3,
            },
          ],
        }),
      ).rejects.toThrow(/must draw from the named scope product/);
    });

    it('refuses unequal declared source and destination amounts', async () => {
      const source = await createProduct(em, seed.organizationId);
      const destination = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: source,
          intents: [
            { productId: source, declaredAmount: 3, intentSign: -1 },
            { productId: destination, declaredAmount: 4, intentSign: 1 },
          ],
          movements: [
            {
              productId: source,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
            {
              productId: destination,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 4,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve across the whole transaction/);
    });

    it('refuses moving stock from a product to itself', async () => {
      const product = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: product,
          intents: [{ productId: product, declaredAmount: 3, intentSign: -1 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -3,
            },
          ],
        }),
      ).rejects.toThrow(/exactly 2 intent lines/);
    });
  });

  describe('the two product-changing types', () => {
    it('FAMILY_STOCK_DISTRIBUTION carries a negative source line and positive destinations', async () => {
      const root = await createProduct(em, seed.organizationId);
      const childA = await createProduct(em, seed.organizationId, root);
      const childB = await createProduct(em, seed.organizationId, root);
      await opening(root, seed.warehouseId, 10);

      await post({
        type: 'FAMILY_STOCK_DISTRIBUTION',
        scopeProductId: root,
        intents: [
          { productId: root, declaredAmount: 10, intentSign: -1 },
          { productId: childA, declaredAmount: 6, intentSign: 1 },
          { productId: childB, declaredAmount: 4, intentSign: 1 },
        ],
        movements: [
          {
            productId: root,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: -10,
          },
          {
            productId: childA,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: 6,
          },
          {
            productId: childB,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: 4,
          },
        ],
      });

      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, root)).toBe(0);
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, childA)).toBe(6);
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, childB)).toBe(4);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);
    });

    it('refuses a destination outside the named family', async () => {
      const root = await createProduct(em, seed.organizationId);
      const stranger = await createProduct(em, seed.organizationId);
      await opening(root, seed.warehouseId, 5);
      await expect(
        post({
          type: 'FAMILY_STOCK_DISTRIBUTION',
          scopeProductId: root,
          intents: [
            { productId: root, declaredAmount: 5, intentSign: -1 },
            { productId: stranger, declaredAmount: 5, intentSign: 1 },
          ],
          movements: [
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
            {
              productId: stranger,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/may only distribute to children of/);
    });

    it('refuses a distribution that does not conserve across the transaction', async () => {
      const root = await createProduct(em, seed.organizationId);
      const child = await createProduct(em, seed.organizationId, root);
      await opening(root, seed.warehouseId, 10);
      await expect(
        post({
          type: 'FAMILY_STOCK_DISTRIBUTION',
          scopeProductId: root,
          intents: [
            { productId: root, declaredAmount: 5, intentSign: -1 },
            { productId: child, declaredAmount: 6, intentSign: 1 },
          ],
          movements: [
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
            {
              productId: child,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 6,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve across the whole transaction/);
    });

    it('PRODUCT_STOCK_REASSIGNMENT names exactly two products', async () => {
      const root = await createProduct(em, seed.organizationId);
      const child = await createProduct(em, seed.organizationId, root);
      const third = await createProduct(em, seed.organizationId, root);
      await opening(root, seed.warehouseId, 9);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: root,
          intents: [
            { productId: root, declaredAmount: 9, intentSign: -1 },
            { productId: child, declaredAmount: 5, intentSign: 1 },
            { productId: third, declaredAmount: 4, intentSign: 1 },
          ],
          movements: [
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -9,
            },
            {
              productId: child,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
            {
              productId: third,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 4,
            },
          ],
        }),
      ).rejects.toThrow(/exactly 2 intent lines/);
    });

    it('refuses a cross-product move with no declared source', async () => {
      const root = await createProduct(em, seed.organizationId);
      const child = await createProduct(em, seed.organizationId, root);
      await expect(
        post({
          type: 'PRODUCT_STOCK_REASSIGNMENT',
          scopeProductId: root,
          intents: [
            { productId: root, declaredAmount: 5, intentSign: 1 },
            { productId: child, declaredAmount: 5, intentSign: 1 },
          ],
          movements: [
            {
              productId: root,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
            {
              productId: child,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/must conserve across the whole transaction/);
    });
  });

  describe('total-changing types declare per product', () => {
    it('refuses an intent that does not match the movement', async () => {
      const product = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'RECEIPT',
          intents: [{ productId: product, declaredAmount: 5, intentSign: 1 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 7,
            },
          ],
        }),
      ).rejects.toThrow(/changed by 7 but declared 5/);
    });

    it('refuses a product that moves without declaring intent', async () => {
      const productA = await createProduct(em, seed.organizationId);
      const productB = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'RECEIPT',
          intents: [{ productId: productA, declaredAmount: 5, intentSign: 1 }],
          movements: [
            {
              productId: productA,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
            {
              productId: productB,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/moves without a declared intent/);
    });

    it('refuses a declaration that moves nothing', async () => {
      const productA = await createProduct(em, seed.organizationId);
      const productB = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'RECEIPT',
          intents: [
            { productId: productA, declaredAmount: 5, intentSign: 1 },
            { productId: productB, declaredAmount: 5, intentSign: 1 },
          ],
          movements: [
            {
              productId: productA,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 5,
            },
          ],
        }),
      ).rejects.toThrow(/declares intent but moves nothing/);
    });

    it('refuses a sign the type does not admit', async () => {
      const product = await createProduct(em, seed.organizationId);
      await expect(
        post({
          type: 'RECEIPT',
          intents: [{ productId: product, declaredAmount: 5, intentSign: -1 }],
          movements: [
            {
              productId: product,
              locationId: seed.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: -5,
            },
          ],
        }),
      ).rejects.toThrow(/does not admit intent sign/);
    });
  });

  describe('transit and the organization total', () => {
    it('counts in-transit stock in the organization total and excludes it from sellable', async () => {
      const product = await createProduct(em, seed.organizationId);
      // From P5-B5 a transit entry must name a REAL transfer: the composite key
      // B1 deferred now exists, and a synthetic id is refused.
      const [transfer]: { id: string }[] = await em.execute(
        `insert into inventory_transfers
           (organization_id, source_location_id, destination_location_id, status, created_at, updated_at)
         values (?::uuid, ?::uuid, ?::uuid, 'DRAFT', now(), now()) returning id`,
        [seed.organizationId, seed.warehouseId, seed.storeLocationId],
      );
      const transferId = transfer.id;
      await opening(product, seed.warehouseId, 10);

      await post({
        type: 'TRANSFER_DISPATCH',
        transferId,
        intents: [{ productId: product, declaredAmount: 4, intentSign: 0 }],
        movements: [
          {
            productId: product,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: -4,
          },
          {
            productId: product,
            locationId: null,
            physicalCondition: 'GOOD',
            operationalState: 'IN_TRANSIT',
            transferId,
            transitDirection: 'DISPATCH',
            quantityDelta: 4,
          },
        ],
      });

      // Owner decision 1: owned total includes transit; sellable excludes it.
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, product)).toBe(10);
      expect(await reconciliation.sellableQuantity(seed.organizationId, product)).toBe(6);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);
    });

    it('a transit entry resolves to exactly one transit cell and a located entry to none', async () => {
      const rows: { located: number; transit: number }[] = await em.execute(
        `select (select count(*)::int from inventory_entries where organization_id = ?::uuid and location_id is not null) as located,
                (select count(*)::int from inventory_entries where organization_id = ?::uuid and location_id is null) as transit`,
        [seed.organizationId, seed.organizationId],
      );
      expect(rows[0].located).toBeGreaterThan(0);
      expect(rows[0].transit).toBeGreaterThan(0);
      const orphans: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_entries e
          where e.organization_id = ?::uuid and e.location_id is null
            and not exists (select 1 from inventory_transit_balances t
                             where t.organization_id = e.organization_id and t.transfer_id = e.transfer_id
                               and t.transit_direction = e.transit_direction and t.product_id = e.product_id
                               and t.physical_condition = e.physical_condition)`,
        [seed.organizationId],
      );
      expect(orphans[0].n).toBe(0);
    });
  });

  describe('the equations catch injected drift', () => {
    it('detects a located balance that no longer matches its entries', async () => {
      const product = await createProduct(em, seed.organizationId);
      await opening(product, seed.warehouseId, 8);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);

      await em.execute(`select set_config('cataloguer.posting', 'on', false)`);
      await em.execute(
        `update inventory_balances set quantity = quantity + 1 where product_id = ?::uuid and location_id = ?::uuid`,
        [product, seed.warehouseId],
      );
      const drifted = await reconciliation.verifyAll(seed.organizationId);
      expect(drifted.length).toBeGreaterThan(0);
      expect(drifted.map((f) => f.invariant).join(',')).toMatch(/LOCATED_BALANCE|ORGANIZATION_PHYSICAL_TOTAL/);

      await em.execute(
        `update inventory_balances set quantity = quantity - 1 where product_id = ?::uuid and location_id = ?::uuid`,
        [product, seed.warehouseId],
      );
      await em.execute(`select set_config('cataloguer.posting', 'off', false)`);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);
    });

    it('detects a transit balance that no longer matches its entries', async () => {
      await em.execute(`select set_config('cataloguer.posting', 'on', false)`);
      await em.execute(`update inventory_transit_balances set quantity = quantity + 2`);
      const drifted = await reconciliation.verifyTransitBalances(seed.organizationId);
      expect(drifted.length).toBeGreaterThan(0);
      await em.execute(`update inventory_transit_balances set quantity = quantity - 2`);
      await em.execute(`select set_config('cataloguer.posting', 'off', false)`);
      expect(await reconciliation.verifyTransitBalances(seed.organizationId)).toEqual([]);
    });
  });

  describe('activation matrix', () => {
    it('claims only what B1 can support', () => {
      const b1 = Object.entries(INVARIANT_ACTIVATION)
        .filter(([, boundary]) => boundary === 'B1')
        .map(([name]) => name);
      expect(b1).toEqual(
        expect.arrayContaining([
          'LOCATED_BALANCE_FORWARD',
          'TRANSIT_BALANCE_FORWARD',
          'STORE_HELD_PROJECTION',
          'ORGANIZATION_PHYSICAL_TOTAL',
          'SELLABLE_AVAILABLE_TOTAL',
          'CONSERVATION_PER_PRODUCT_INTENT',
        ]),
      );
      // Deferred invariants must NOT be advertised as active in B1.
      expect(INVARIANT_ACTIVATION.RESERVATION_AGGREGATE_EQUALITY).toBe('B4');
      expect(INVARIANT_ACTIVATION.BACKORDER_CREATES_NO_ENTRIES).toBe('B4');
      expect(INVARIANT_ACTIVATION.LEGACY_PRODUCT_CACHE_EQUALITY).toBe('B3');
      expect(INVARIANT_ACTIVATION.LEGACY_STORE_PRODUCT_CACHE_EQUALITY).toBe('B3');
      expect(INVARIANT_ACTIVATION.OPENING_RECONCILIATION_APPROVED).toBe('B2');
      expect(INVARIANT_ACTIVATION.TRANSFER_LIFECYCLE_INTEGRITY).toBe('B5');
    });

    it('the legacy columns now follow the ledger — B3 activated them', async () => {
      // B1 asserted these columns stayed at zero because nothing wrote them.
      // B3 made them ledger-derived caches, so the correct assertion is no
      // longer "untouched" but "equal to what the ledger says".
      // The organization's owned total is located PLUS in-transit (owner
      // decision 1), and the cache mirrors exactly that — so the check must
      // add both, or a transfer in flight would look like drift.
      const drift: { detail: string }[] = await em.execute(
        `select p.id || ' cache=' || p.stock_quantity || ' ledger=' || coalesce(l.total, 0) as detail
           from products p
           left join (
             select product_id, sum(q)::int as total from (
               select product_id, quantity as q from inventory_balances where organization_id = ?::uuid
               union all
               select product_id, quantity from inventory_transit_balances where organization_id = ?::uuid
             ) owned group by product_id
           ) l on l.product_id = p.id
          where p.organization_id = ?::uuid and p.stock_quantity <> coalesce(l.total, 0)`,
        [seed.organizationId, seed.organizationId, seed.organizationId],
      );
      expect(drift).toEqual([]);
    });
  });
});
