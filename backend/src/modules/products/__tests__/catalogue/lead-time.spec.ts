import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BranchAssignmentDto } from '../../dto/branch-assignment.dto';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { mapProductToPublicDto } from '../../../public-catalogue/dto/public-catalogue.dto';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { stockDouble } from '../../../../../test/inventory-stock-support';
import { productFamilyLock } from '../../families/advisory-lock.util';

/**
 * B3: lead time is a BRANCH's statement about ONE item.
 *
 * Null means "not stated" and is a different fact from 0 ("ships
 * immediately"), so nothing may default it. A family card is never fulfilled,
 * so it states no lead time at all — each version answers for itself.
 */

const errorsFor = async (payload: Record<string, unknown>) =>
  validate(plainToInstance(BranchAssignmentDto, payload), { whitelist: true });

const coll = (items: any[] = []) => ({
  getItems: () => items,
  isInitialized: () => true,
  count: () => items.length,
});

const link = (storeId: string, over: Record<string, any> = {}) => ({
  store: { id: storeId },
  // The entity DEFAULTS this to false. Omitting it here made a store-less
  // child read as visible, which is the defect this branch closes.
  published: true,
  price: null,
  salePrice: null,
  stockQuantity: 2,
  trackInventory: true,
  leadTimeDays: null as number | null,
  ...over,
});

const item = (over: Record<string, any> = {}) => ({
  id: 'p1',
  name: 'Chair',
  slug: 'chair',
  price: 100,
  salePrice: null,
  stockQuantity: 2,
  trackInventory: true,
  status: ProductStatus.PUBLISHED,
  archivedAt: null,
  categories: coll(),
  images: coll(),
  branchLinks: coll(),
  parent: null,
  children: coll(),
  ...over,
});

describe('BranchAssignmentDto.leadTimeDays validation', () => {
  it('accepts a non-negative integer, including 0 and a value beyond a year', async () => {
    expect(await errorsFor({ leadTimeDays: 0 })).toHaveLength(0);
    expect(await errorsFor({ leadTimeDays: 45 })).toHaveLength(0);
    // Made-to-order furniture legitimately runs past a year: no upper bound.
    expect(await errorsFor({ leadTimeDays: 400 })).toHaveLength(0);
  });

  it('rejects a negative value and a non-integer', async () => {
    expect(await errorsFor({ leadTimeDays: -1 })).not.toHaveLength(0);
    expect(await errorsFor({ leadTimeDays: 2.5 })).not.toHaveLength(0);
    expect(await errorsFor({ leadTimeDays: 'soon' })).not.toHaveLength(0);
  });

  it('treats omission as "leave unchanged" rather than a value', async () => {
    const dto = plainToInstance(BranchAssignmentDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.leadTimeDays).toBeUndefined();
  });

  it('accepts an explicit null, which is how a branch clears the value', async () => {
    expect(await errorsFor({ leadTimeDays: null })).toHaveLength(0);
    const dto = plainToInstance(BranchAssignmentDto, { leadTimeDays: null });
    // null must survive as null — distinct from undefined, which means
    // "leave unchanged" once it reaches the service.
    expect(dto.leadTimeDays).toBeNull();
  });
});

describe('ProductsService.assignToStore — lead time persistence', () => {
  const ORG = { id: 'org-1' };
  const PRODUCT = 'p1';
  const STORE = 's1';

  /**
   * Wires the three lookups assignToStore makes (product, store, existing
   * link). Only persistence is mocked: the field logic under test is the
   * service's own.
   */
  function serviceWith(existingLink: any | null) {
    const created: any[] = [];
    // Every advisory lock the assignment takes, as PostgreSQL would receive it.
    const locks: { ns: number; key: number }[] = [];
    // assignToStore runs in its own transaction now (B4a3); one object serves
    // as root and transactional manager, entity-keyed like the real lookups.
    const em: any = {
      findOne: jest.fn(async (entity: any) => {
        const name = entity?.name ?? String(entity);
        if (name === 'Product') return { id: PRODUCT, name: 'Chair', organization: ORG };
        if (name === 'Store') return { id: STORE, name: 'Branch', organization: ORG };
        if (name === 'StoreProduct') return existingLink;
        return null;
      }),
      create: jest.fn((_entity: any, data: any) => {
        const link = { ...data, leadTimeDays: undefined as number | null | undefined };
        created.push(link);
        return link;
      }),
      persist: jest.fn(),
      flush: jest.fn(),
      // The card guards ask how many children a product has before any
      // sellable-only field is written. These doubles describe ordinary
      // standalone products, so the honest answer is zero.
      count: jest.fn().mockResolvedValue(0),
      // The card reconciliation asks where the product sits in its family as
      // the DATABASE has it, so a product attached since it was loaded still
      // has its card reconciled. This one is a standalone: no parent.
      find: jest.fn(async () => [{ id: PRODUCT, parent: null }]),
      // The assignment decides under the product's family lock, taken with
      // `pg_advisory_xact_lock` on the transaction's own connection.
      execute: jest.fn(async (sql: string, params: number[] = []) => {
        if (/pg_advisory_xact_lock/.test(sql)) locks.push({ ns: params[0], key: params[1] });
        return [];
      }),
    };
    em.transactional = jest.fn(async (cb: any) => cb(em));
    const productRepository = {
      findOne: jest.fn(async () => ({ id: PRODUCT, name: 'Chair', organization: ORG })),
      getEntityManager: () => em,
    };
    const service = new ProductsService(
      productRepository as any,
      {} as any,
      {} as any,
      { recordAuditEntry: jest.fn() } as any,
      { learnFromAcceptedGroup: jest.fn() } as any,
      new PublicationGuardService(),
      {} as any,
      stockDouble() as any,
    );
    return { service, em, created, locks };
  }

  const existing = (over: Record<string, any> = {}) => ({
    id: 'link-1',
    store: { id: STORE },
    product: { id: PRODUCT },
    published: true,
    price: null,
    salePrice: null,
    cost: null,
    stockQuantity: 4,
    trackInventory: true,
    leadTimeDays: 21 as number | null,
    ...over,
  });

  it('preserves an existing lead time when the body omits the field', async () => {
    const link = existing();
    const { service, em } = serviceWith(link);

    const result = await service.assignToStore(PRODUCT, STORE, {} as any);

    expect(result.leadTimeDays).toBe(21);
    expect(link.leadTimeDays).toBe(21);
    expect(em.flush).toHaveBeenCalled();
  });

  it('decides a lead-time edit under the product family lock, and no store lock', async () => {
    // Publishes nothing, so no store key; the family key is taken anyway,
    // because whether this product is a card is a family-shape fact.
    const { service, locks } = serviceWith(existing());

    await service.assignToStore(PRODUCT, STORE, { leadTimeDays: 10 } as any);

    expect(locks).toEqual([productFamilyLock(PRODUCT)]);
  });

  it('sets 0 — ships immediately is a real value, not a cleared one', async () => {
    const link = existing();
    const { service } = serviceWith(link);

    const result = await service.assignToStore(PRODUCT, STORE, { leadTimeDays: 0 } as any);

    expect(result.leadTimeDays).toBe(0);
    expect(result.leadTimeDays).not.toBeNull();
  });

  it('clears the value when the body sends an explicit null', async () => {
    const link = existing();
    const { service } = serviceWith(link);

    const result = await service.assignToStore(PRODUCT, STORE, { leadTimeDays: null } as any);

    expect(result.leadTimeDays).toBeNull();
  });

  it('accepts a lead time on a branch link that did not exist yet', async () => {
    const { service, em, created } = serviceWith(null);

    const result = await service.assignToStore(PRODUCT, STORE, { leadTimeDays: 45 } as any);

    expect(em.create).toHaveBeenCalled();
    expect(em.persist).toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(result.leadTimeDays).toBe(45);
  });

  it('leaves a new link with no lead time when the body omits it', async () => {
    const { service, created } = serviceWith(null);

    const result = await service.assignToStore(PRODUCT, STORE, {} as any);

    expect(created).toHaveLength(1);
    // Never defaulted to 0: an unstated lead time stays unstated.
    expect(result.leadTimeDays).toBeUndefined();
  });

  it('does not disturb the other branch fields while setting a lead time', async () => {
    const link = existing({ price: '31.00', stockQuantity: 9, published: false, trackInventory: false });
    const { service } = serviceWith(link);

    await service.assignToStore(PRODUCT, STORE, { leadTimeDays: 7 } as any);

    expect(link.price).toBe('31.00');
    expect(link.stockQuantity).toBe(9);
    expect(link.published).toBe(false);
    expect(link.trackInventory).toBe(false);
    expect(link.leadTimeDays).toBe(7);
  });
});

describe('public DTO lead-time resolution', () => {
  it('reports a standalone item own branch value', () => {
    const dto = mapProductToPublicDto(item({ branchLinks: coll([link('s1', { leadTimeDays: 14 })]) }) as any, 's1');
    expect(dto.leadTimeDays).toBe(14);
    expect(dto.purchasable).toBe(true);
  });

  it('distinguishes 0 (ships immediately) from null (not stated)', () => {
    const immediate = mapProductToPublicDto(
      item({ branchLinks: coll([link('s1', { leadTimeDays: 0 })]) }) as any,
      's1',
    );
    expect(immediate.leadTimeDays).toBe(0);

    const unstated = mapProductToPublicDto(item({ branchLinks: coll([link('s1')]) }) as any, 's1');
    expect(unstated.leadTimeDays).toBeNull();
  });

  it('reports null when the branch has no link, and when no store is asked for', () => {
    expect(mapProductToPublicDto(item({ branchLinks: coll([link('other')]) }) as any, 's1').leadTimeDays).toBeNull();
    expect(
      mapProductToPublicDto(item({ branchLinks: coll([link('s1', { leadTimeDays: 9 })]) }) as any).leadTimeDays,
    ).toBeNull();
  });

  it('never states a lead time for a family card, even when its pivot carries one', () => {
    // Creation timestamps pin the selector order (B4b): versions render by
    // (createdAt, id), so the fixture states its insertion order explicitly.
    const child = (id: string, days: number | null, createdAt: string) =>
      item({
        id,
        optionLabel: id,
        createdAt: new Date(createdAt),
        branchLinks: coll([link('s1', { leadTimeDays: days })]),
        children: coll(),
      });
    const card = item({
      id: 'card',
      // The card's own visibility pivot deliberately carries a value: it must
      // still be reported as null, never applied to the versions.
      branchLinks: coll([link('s1', { leadTimeDays: 99 })]),
      children: coll([child('green', 3, '2026-01-01T00:00:00Z'), child('brown', 60, '2026-01-01T00:00:01Z')]),
    });

    const dto = mapProductToPublicDto(card as any, 's1');
    expect(dto.leadTimeDays).toBeNull();
    expect(dto.purchasable).toBe(false);
    // Each version answers for itself — no inheritance, no single family number.
    expect(dto.children.map((v) => v.leadTimeDays)).toEqual([3, 60]);
  });

  it('gives a version fetched on its own its branch value', () => {
    const version = item({
      id: 'green',
      parent: { id: 'card' },
      optionLabel: 'Green',
      branchLinks: coll([link('s1', { leadTimeDays: 3 })]),
    });
    const dto = mapProductToPublicDto(version as any, 's1');
    expect(dto.leadTimeDays).toBe(3);
    expect(dto.purchasable).toBe(true);
  });

  it('leaves a version without a stated lead time as null rather than borrowing one', () => {
    const card = item({
      id: 'card',
      branchLinks: coll([link('s1', { leadTimeDays: 99 })]),
      children: coll([item({ id: 'green', optionLabel: 'Green', branchLinks: coll([link('s1')]), children: coll() })]),
    });
    expect(mapProductToPublicDto(card as any, 's1').children[0].leadTimeDays).toBeNull();
  });
});
