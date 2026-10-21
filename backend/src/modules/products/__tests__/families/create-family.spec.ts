import { BadRequestException } from '@nestjs/common';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { stockDouble } from '../../../../../test/inventory-stock-support';

/**
 * B2, admin family creation.
 *
 * Grouping turns standalone items into versions of one model. The card the
 * customer sees must appear in every branch its versions were sold in — but
 * the versions keep their own branch state, because they are the real items.
 * An item that belongs to no branch cannot become a version at all: the family
 * would present something no branch can actually sell.
 */

const store = (id: string) => ({ id });

/** A StoreProduct row: the branch's own price, stock, publication, tracking. */
const branchLink = (storeId: string, over: Record<string, any> = {}) => ({
  store: { id: storeId },
  published: true,
  price: '12.50',
  salePrice: '9.99',
  cost: '5.00',
  stockQuantity: 4,
  trackInventory: true,
  ...over,
});

const memberProduct = (id: string, stores: any[], categories: any[] = [], links?: any[]) => {
  const storeItems = [...stores];
  const categoryItems = [...categories];
  const linkItems = links ?? stores.map((s) => branchLink(s.id));
  return {
    id,
    name: 'item-' + id,
    price: '10.00',
    status: 'PUBLISHED',
    organization: { id: 'org-1' },
    parent: null,
    optionLabel: undefined as string | undefined,
    categories: { getItems: () => categoryItems, add: (c: any) => categoryItems.push(c) },
    stores: { getItems: () => storeItems, add: (s: any) => storeItems.push(s) },
    branchLinks: { getItems: () => linkItems, isInitialized: () => true, count: () => linkItems.length },
  };
};

function serviceWith(members: any[]) {
  const created: any[] = [];
  const pivots: any[] = [];
  const byId = new Map(members.map((m) => [m.id, m]));
  // Group creation runs in one guarded transaction now (B4a3); one
  // entity-keyed object serves as root and transactional manager.
  const em: any = {
    findOne: jest.fn(async (entity: any, where: any) =>
      (typeof entity === 'function' ? entity.name : String(entity)) === 'Product'
        ? (byId.get(where?.id) ?? null)
        : null,
    ),
    find: jest.fn(async (entity: any, where: any) => {
      const name = typeof entity === 'function' ? entity.name : String(entity);
      if (name === 'Product') return (where?.id?.$in ?? []).map((id: string) => byId.get(id)).filter(Boolean);
      if (name === 'Store') return (where?.id?.$in ?? []).map((id: string) => ({ id }));
      return [];
    }),
    count: jest.fn(
      async (_entity: any, where: any) => members.filter((m) => (m.parent?.id ?? m.parent) === where?.parent).length,
    ),
    create: jest.fn((entity: any, data: any) => {
      const name = typeof entity === 'function' ? entity.name : String(entity);
      if (name === 'StoreProduct') {
        pivots.push(data);
        return data;
      }
      const parentCategories: any[] = [];
      const parent = {
        ...data,
        id: 'parent-1',
        categories: { getItems: () => parentCategories, add: (c: any) => parentCategories.push(c) },
        stores: { getItems: () => [] },
      };
      created.push(parent);
      return parent;
    }),
    persist: jest.fn(),
    remove: jest.fn(),
    persistAndFlush: jest.fn(),
    flush: jest.fn(),
    execute: jest.fn(async () => []),
  };
  em.transactional = jest.fn(async (cb: any) => cb(em));
  // Creation re-runs its whole validation prelude after the locks, on a fork
  // bound to the same transaction. The double has one manager, so the fork is
  // itself — which is what a unit test wants: the same rows, read again.
  em.fork = jest.fn(() => em);
  em.setTransactionContext = jest.fn();
  em.getTransactionContext = jest.fn(() => undefined);
  const productRepository = {
    // uniqueProductSlug probes for slug collisions (answered null = free).
    findOne: jest.fn(async () => null),
    getEntityManager: () => em,
  };
  // Exposed, because a rename that commits without its record is exactly the
  // failure the transactional audit exists to prevent.
  const audit = { recordAuditEntry: jest.fn(), recordAuditEntryIn: jest.fn() };
  const service = new ProductsService(
    productRepository as any,
    {} as any,
    {} as any,
    // The family audit entry is written INSIDE the transaction now
    // (`recordAuditEntryIn`), so an unrecorded family cannot commit.
    audit as any,
    { learnFromAcceptedGroup: jest.fn() } as any,
    new PublicationGuardService(),
    {} as any,
    stockDouble() as any,
  );
  return { service, em, created, pivots, productRepository, audit };
}

describe('ProductsService.createFamily — B2 family creation', () => {
  const actor = { id: 'u1', email: 'ana@acme.com', store: null };

  it('refuses an item that belongs to no branch', async () => {
    const branchless = memberProduct('a', []);
    const ok = memberProduct('b', [store('s1')]);
    const { service, em } = serviceWith([branchless, ok]);

    await expect(
      service.createFamily(
        'Chair Walter',
        [
          { id: 'a', label: 'Green' },
          { id: 'b', label: 'Brown' },
        ],
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    // Nothing was created: the family never came into existence.
    expect(em.create).not.toHaveBeenCalled();
    expect(branchless.parent).toBeNull();
  });

  it('gives the card the union of its versions branches (visibility)', async () => {
    const a = memberProduct('a', [store('s1')]);
    const b = memberProduct('b', [store('s2'), store('s1')]);
    const { service, created, pivots } = serviceWith([a, b]);

    await service.createFamily(
      'Chair Walter',
      [
        { id: 'a', label: 'Green' },
        { id: 'b', label: 'Brown' },
      ],
      actor,
    );

    // The card reaches its versions' branches through EXPLICIT published
    // pivots (B4a3) — never `stores.add()`, which mints rows with no
    // organization and, since publication defaults to hidden, invisible cards.
    const parent = created[0];
    const parentStoreIds = pivots.map((p: any) => p.store.id ?? p.store).sort();
    expect(parentStoreIds).toEqual(['s1', 's2']); // union, de-duplicated
    pivots.forEach((p: any) => {
      expect(p.published).toBe(true);
      expect(p.organization).toBe('org-1');
      expect(p.product).toBe(parent);
    });
  });

  it('creates a card that carries no stock of its own', async () => {
    const a = memberProduct('a', [store('s1')]);
    const b = memberProduct('b', [store('s1')]);
    const { service, created } = serviceWith([a, b]);

    await service.createFamily(
      'Chair Walter',
      [
        { id: 'a', label: 'Green' },
        { id: 'b', label: 'Brown' },
      ],
      actor,
    );

    // P5-B3: the card states no quantity at all — the column's zero applies,
    // because only the ledger may set one. It is still not inventory-tracked.
    expect(created[0].stockQuantity).toBeUndefined();
    expect(created[0].trackInventory).toBe(false);
  });

  it('leaves every version with its own branch state and label', async () => {
    const a = memberProduct('a', [store('s1')]);
    const b = memberProduct('b', [store('s2')]);
    const { service } = serviceWith([a, b]);

    const result = await service.createFamily(
      'Chair Walter',
      [
        { id: 'a', label: 'Green' },
        { id: 'b', label: 'Brown' },
      ],
      actor,
    );

    expect(result.members).toBe(2);
    // Each version keeps exactly the branches it already sold in — grouping
    // does not move, merge or clear a version's commercial state.
    expect(a.stores.getItems().map((s: any) => s.id)).toEqual(['s1']);
    expect(b.stores.getItems().map((s: any) => s.id)).toEqual(['s2']);
    expect(a.parent).toMatchObject({ id: 'parent-1' });
    expect(b.parent).toMatchObject({ id: 'parent-1' });
    expect(a.optionLabel).toBe('Green');
    expect(b.optionLabel).toBe('Brown');
  });

  it('leaves each version StoreProduct commercial values byte-identical', async () => {
    const a = memberProduct('a', [store('s1')], [], [branchLink('s1', { price: '31.00', stockQuantity: 9 })]);
    const b = memberProduct(
      'b',
      [store('s2')],
      [],
      [branchLink('s2', { published: false, price: null, salePrice: null, stockQuantity: 0, trackInventory: false })],
    );
    const before = JSON.parse(JSON.stringify([a.branchLinks.getItems(), b.branchLinks.getItems()]));
    const { service, pivots } = serviceWith([a, b]);

    await service.createFamily(
      'Chair Walter',
      [
        { id: 'a', label: 'Green' },
        { id: 'b', label: 'Brown' },
      ],
      actor,
    );

    // Price, sale price, cost, stock, tracking and publication are untouched
    // for every version — grouping changes identity, never commerce.
    const after = JSON.parse(JSON.stringify([a.branchLinks.getItems(), b.branchLinks.getItems()]));
    expect(after).toEqual(before);
    // Every pivot the service writes belongs to the CARD (B4a3): the
    // versions' own rows are read to learn which branches to mirror and are
    // never rewritten — grouping changes identity, never commerce.
    expect(pivots).toHaveLength(2);
    pivots.forEach((p: any) => expect(p.product.id).toBe('parent-1'));
  });
});

/**
 * RENAMING A CHILD AS PART OF THE GROUPING (PR D).
 *
 * Reviewing the items is when somebody notices that one is called "Camiseta
 * Small" and should simply be "Small". Sending that afterwards as its own
 * request would allow a group to exist with only some of the names the person
 * confirmed, so the rename happens inside the one transaction that makes the
 * family, and rolls back with it.
 */
describe('ProductsService.createFamily — renaming children', () => {
  const actor = { id: 'u1', email: 'ana@acme.com', store: null };
  const two = () => [memberProduct('a', [store('s1')]), memberProduct('b', [store('s1')])];

  it('applies a requested name to that child, and leaves the others alone', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    members[1].name = 'Camiseta Medium';
    const { service } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S', name: 'Small' },
        { id: 'b', label: 'M' },
      ],
      actor,
    );
    expect(members[0].name).toBe('Small');
    // No name was asked for, so none was written.
    expect(members[1].name).toBe('Camiseta Medium');
  });

  it('never touches anything else about the item', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    (members[0] as any).slug = 'camiseta-small';
    (members[0] as any).sku = 'CAM-S';
    members[0].price = '10.00';
    const { service } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S', name: 'Small' },
        { id: 'b', label: 'M' },
      ],
      actor,
    );
    expect(members[0].name).toBe('Small');
    // The slug is what existing links point at; the SKU is what stock is
    // counted against. A rename moves neither, here or anywhere else.
    expect((members[0] as any).slug).toBe('camiseta-small');
    expect((members[0] as any).sku).toBe('CAM-S');
    expect(members[0].price).toBe('10.00');
  });

  it('keeps the label and the name as two separate writes', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    const { service } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S', name: 'Small' },
        { id: 'b', label: 'M' },
      ],
      actor,
    );
    expect(members[0].name).toBe('Small');
    // The selector still shows its own word.
    expect(members[0].optionLabel).toBe('S');
  });

  it('records each rename against the item, through the same transaction', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    members[1].name = 'Camiseta Medium';
    const { service, em, audit } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S', name: 'Small' },
        { id: 'b', label: 'M', name: 'Medium' },
      ],
      actor,
    );
    const renames = audit.recordAuditEntryIn.mock.calls.filter((c: any[]) => c[5] === 'UPDATE');
    expect(renames).toHaveLength(2);
    // Written against the ITEM, not the card, or the log cannot answer when
    // this item's name changed.
    expect(renames.map((c: any[]) => c[4])).toEqual(['a', 'b']);
    // `{ before, after }`, the shape every other product edit writes.
    expect(renames[0][6]).toEqual({ name: { before: 'Camiseta Small', after: 'Small' } });
    // The message is a CONSTANT: `audit_logs.message` is varchar(255) and both
    // names may be 255 on their own, so neither may appear in it.
    expect(renames[0][7]).toBe('Renamed while grouping.');
    expect(renames[0][7].length).toBeLessThanOrEqual(255);
    // Through THIS transaction, so a rolled-back family leaves no record.
    for (const call of renames) expect(call[0]).toBe(em);
  });

  it('writes no rename record for a child nobody renamed', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    const { service, audit } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S' },
        { id: 'b', label: 'M' },
      ],
      actor,
    );
    expect(audit.recordAuditEntryIn.mock.calls.filter((c: any[]) => c[5] === 'UPDATE')).toHaveLength(0);
  });

  it('treats a name identical to the current one as no rename at all', async () => {
    const members = two();
    members[0].name = 'Camiseta Small';
    const { service, audit } = serviceWith(members);
    await service.createFamily(
      'Camiseta',
      [
        { id: 'a', label: 'S', name: 'Camiseta Small' },
        { id: 'b', label: 'M' },
      ],
      actor,
    );
    expect(members[0].name).toBe('Camiseta Small');
    expect(audit.recordAuditEntryIn.mock.calls.filter((c: any[]) => c[5] === 'UPDATE')).toHaveLength(0);
  });

  it('a refused grouping renames nothing: the whole transaction is one fact', async () => {
    const branchless = memberProduct('a', []);
    branchless.name = 'Camiseta Small';
    const ok = memberProduct('b', [store('s1')]);
    const { service, audit } = serviceWith([branchless, ok]);
    await expect(
      service.createFamily(
        'Camiseta',
        [
          { id: 'a', label: 'S', name: 'Small' },
          { id: 'b', label: 'M' },
        ],
        actor,
      ),
    ).rejects.toThrow();
    // The refusal came before any write.
    expect(branchless.name).toBe('Camiseta Small');
    expect(audit.recordAuditEntryIn).not.toHaveBeenCalled();
  });
});
