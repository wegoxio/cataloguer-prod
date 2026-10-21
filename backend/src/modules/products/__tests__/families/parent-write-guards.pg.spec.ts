import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { Product } from '../../entities/product.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'op@e.test' } as any;

/**
 * What a family CARD may and may not be given, at the boundary rather than in
 * the interface.
 *
 * The editor hides these controls, but hiding a field is not a rule: every one
 * of these writers accepts a body from any client, and each of them could
 * reach a card's stock, its tracking flag, its sale price, its cost, its
 * identity or its shops. The interface is where a person is told; this is
 * where it is decided.
 */
d('a parent card refuses what only a sellable item can mean (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let ORG: string;
  let STORE: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const mkProduct = async (over: { sku?: string; manufacturerCode?: string } = {}) => {
    const name = uid('p');
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, sku, manufacturer_code, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, false, ?, ?, now(), now()) returning id`,
      [name, name, ORG, over.sku ?? null, over.manufacturerCode ?? null],
    );
    await exec(
      `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
      [ORG, STORE, row.id],
    );
    return row.id;
  };

  /** A real card, made the way the product makes one. */
  const mkCard = async () => {
    const a = await mkProduct();
    const b = await mkProduct();
    const created = await products.createFamily(
      uid('fam'),
      [
        { id: a, label: 'A' },
        { id: b, label: 'B' },
      ],
      ACTOR,
    );
    return { cardId: created.id, childIds: [a, b] };
  };

  const scalarsOf = async (id: string) =>
    (
      await exec<
        { sku: string | null; manufacturer_code: string | null; track_inventory: boolean; stock_quantity: number }[]
      >(`select sku, manufacturer_code, track_inventory, stock_quantity from products where id = ?::uuid`, [id])
    )[0];

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
      { learnFromAcceptedGroup: async () => undefined } as any,
      guard,
      fields,
      realStock(em as any),
    );
    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Guard Co', ?, now(), now()) returning id`,
        [uid('guard')],
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

  describe('the product editor', () => {
    it('refuses stock, tracking, sale price, cost and a store-membership replacement', async () => {
      const { cardId } = await mkCard();
      const before = await scalarsOf(cardId);

      for (const [dto, pattern] of [
        [{ stockQuantity: 5 }, /cannot hold stock/i],
        [{ trackInventory: true }, /cannot track inventory/i],
        [{ salePrice: 3 }, /never sold at a sale price/i],
        [{ cost: 2 }, /never bought/i],
        [{ storeIds: [STORE] }, /worked out from its child products/i],
      ] as [any, RegExp][]) {
        await expect(products.update(cardId, dto, ORG, ACTOR)).rejects.toThrow(pattern);
      }

      // Nothing was written by any of the refused attempts.
      expect(await scalarsOf(cardId)).toEqual(before);
    });

    it('accepts the card’s own descriptive fields, its status and its SORTING PRICE', async () => {
      const { cardId } = await mkCard();
      await products.update(
        cardId,
        {
          name: 'Camiseta',
          description: 'La ficha',
          metaTitle: 'T',
          metaDescription: 'D',
          price: 42,
          status: ProductStatus.DRAFT,
        },
        ORG,
        ACTOR,
      );
      const [row] = await exec<{ name: string; description: string; price: string; status: string }[]>(
        `select name, description, price, status from products where id = ?::uuid`,
        [cardId],
      );
      expect(row.name).toBe('Camiseta');
      expect(row.description).toBe('La ficha');
      // The sorting price is the card's own figure and is never charged: the
      // children keep their prices, which is what a customer pays.
      expect(Number(row.price)).toBe(42);
      expect(row.status).toBe('DRAFT');
    });

    it('leaves an ordinary standalone product completely unaffected', async () => {
      // Stock deliberately not exercised here: moving units needs the
      // organization's opening epoch, which is the inventory suite's subject.
      // What matters for THIS rule is that a standalone is refused nothing.
      const solo = await mkProduct();
      await products.update(solo, { trackInventory: true, salePrice: 4, cost: 2, sku: 'SOLO-OK' }, ORG, ACTOR);
      const after = await scalarsOf(solo);
      expect(after.track_inventory).toBe(true);
      expect(after.sku).toBe('SOLO-OK');
    });
  });

  describe('identity fields on a card (the legacy-clearing rule)', () => {
    /** A card that already carries a SKU, as an older import could leave one. */
    const legacyCard = async () => {
      const { cardId } = await mkCard();
      // Unique per call: `products_organization_id_sku_unique` is real, and a
      // shared literal would make the second test in this block collide.
      const sku = uid('LEGACY').toUpperCase();
      const code = uid('MFG').toUpperCase();
      await exec(`update products set sku = ?, manufacturer_code = ? where id = ?::uuid`, [sku, code, cardId]);
      em.clear();
      return { cardId, sku, code };
    };

    it('accepts the value it already has as a no-op, whitespace and all', async () => {
      const { cardId, sku, code } = await legacyCard();
      await products.update(cardId, { sku: `  ${sku}  `, manufacturerCode: code }, ORG, ACTOR);
      const after = await scalarsOf(cardId);
      expect(after.sku).toBe(sku);
      expect(after.manufacturer_code).toBe(code);
    });

    it('CLEARS a legacy value when an empty or whitespace-only one is sent', async () => {
      const { cardId } = await legacyCard();
      await products.update(cardId, { sku: '', manufacturerCode: '   ' }, ORG, ACTOR);
      const after = await scalarsOf(cardId);
      expect(after.sku).toBeNull();
      expect(after.manufacturer_code).toBeNull();
    });

    it('REFUSES a different value, before anything is written', async () => {
      const { cardId } = await legacyCard();
      const before = await scalarsOf(cardId);
      await expect(products.update(cardId, { sku: 'NEW-1' }, ORG, ACTOR)).rejects.toThrow(/cannot be given a SKU/i);
      await expect(products.update(cardId, { manufacturerCode: 'MFG-2' }, ORG, ACTOR)).rejects.toThrow(
        /cannot be given a manufacturer code/i,
      );
      expect(await scalarsOf(cardId)).toEqual(before);
    });

    it('omitting them changes nothing', async () => {
      const { cardId, sku, code } = await legacyCard();
      await products.update(cardId, { name: 'Renamed' }, ORG, ACTOR);
      const after = await scalarsOf(cardId);
      expect(after.sku).toBe(sku);
      expect(after.manufacturer_code).toBe(code);
    });
  });

  describe('the single-store endpoints', () => {
    it('refuse a direct assignment and a direct removal for a card', async () => {
      const { cardId } = await mkCard();
      await expect(products.assignToStore(cardId, STORE, { published: true } as any, ACTOR)).rejects.toThrow(
        /worked out from its child products/i,
      );
      await expect(products.removeFromStore(cardId, STORE, ACTOR)).rejects.toThrow(
        /worked out from its child products/i,
      );
      // The derived listing the family gave it is still there.
      const [{ n }] = await exec<{ n: number }[]>(
        `select count(*)::int n from store_products where product_id = ?::uuid`,
        [cardId],
      );
      expect(n).toBeGreaterThan(0);
    });

    it('still accept both for a standalone product', async () => {
      const solo = await mkProduct();
      await products.assignToStore(solo, STORE, { published: true } as any, ACTOR);
      await products.removeFromStore(solo, STORE, ACTOR);
    });
  });
});
