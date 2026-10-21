import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductFamilyService } from '../../families/product-family.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';

/**
 * Collection stand-in. `isInitialized` is part of the real shape and the
 * membership guard depends on it: an unloaded collection must NOT read as
 * empty, or a parent would pass the childless check.
 */
const coll = (items: any[] = []) => ({
  getItems: () => items,
  count: () => items.length,
  isInitialized: () => true,
});
const actor = { id: 'u1', email: 'ana@acme.com', store: null };

describe('ProductFamilyService (P0-15 management)', () => {
  let service: ProductFamilyService;
  let rows: Record<string, any>;
  let em: any;
  let audit: any;

  const parent = (children: any[] = []) => ({
    id: 'walter',
    name: 'Chair Walter',
    organization: { id: 'org-1' },
    parent: null,
    children: coll(children),
  });

  /** Registers fixtures in the id-keyed world the transactional fake serves. */
  const withRows = (...fixtures: any[]) => {
    for (const fixture of fixtures) rows[fixture.id] = fixture;
  };

  const parentIdOf = (row: any) => row.parent?.id ?? row.parent ?? null;

  beforeEach(() => {
    rows = {};
    // Shape transitions run in a transaction under the family locks now
    // (B4a3); one entity-keyed object serves as root and transactional
    // manager over the id-keyed rows.
    em = {
      findOne: jest.fn(async (entity: any, where: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        return name === 'Product' ? (rows[where.id] ?? null) : null;
      }),
      find: jest.fn(async (entity: any, where: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        // The member's pivots, re-read when the keys are named: the same
        // `stores` the locked read below answers from, so the two agree.
        if (name === 'StoreProduct') {
          const productId = where?.product?.id ?? where?.product;
          return (rows[productId]?.stores?.getItems?.() ?? []).map((store: any) => ({
            store: { id: store.id },
            product: { id: productId },
            published: store.published ?? true,
          }));
        }
        if (name !== 'Product') return [];
        if (where.parent !== undefined) return Object.values(rows).filter((row) => parentIdOf(row) === where.parent);
        if (where.id?.$in) return where.id.$in.map((id: string) => rows[id]).filter(Boolean);
        return [];
      }),
      count: jest.fn(
        async (_entity: any, where: any) =>
          Object.values(rows).filter((row) => parentIdOf(row) === where?.parent).length,
      ),
      flush: jest.fn(),
      // The member is re-hydrated from its row before it is judged: here the
      // fixture IS the row, so the instance comes back as it is.
      refresh: jest.fn(async (entity: any) => entity),
      // The visibility rules read the two products' pivots under a row lock,
      // raw. Answered from each fixture's `stores`, as published: a member in
      // no store is refused by the rule that reads exactly this.
      execute: jest.fn(async (sql: string, params: any[] = []) => {
        if (!/from store_products/i.test(String(sql))) return [];
        // The member's pivots in REMOVED stores, named for their keys: none
        // of these fixtures has one.
        if (/removed_at is not null/i.test(String(sql))) return [];
        return params.flatMap((id: string) =>
          (rows[id]?.stores?.getItems?.() ?? []).map((store: any) => ({
            product_id: id,
            store_id: store.id,
            published: store.published ?? true,
          })),
        );
      }),
    };
    em.transactional = jest.fn(async (cb: any) => cb(em));
    audit = { recordAuditEntry: jest.fn() };
    service = new ProductFamilyService(
      { findOne: jest.fn(), getEntityManager: () => em } as any,
      audit,
      new PublicationGuardService(),
    );
  });

  describe('addMember', () => {
    it('files a free item as a version with its label', async () => {
      const member: any = {
        id: 'green',
        name: 'Chair Walter Green',
        organization: { id: 'org-1' },
        parent: null,
        children: coll(),
        stores: coll([{ id: 's1' }]),
      };
      withRows(parent(), member);

      const result = await service.addMember('walter', { productId: 'green', label: ' Green ' }, actor);

      expect(member.parent.id).toBe('walter');
      expect(member.optionLabel).toBe('Green');
      expect(result.member).toEqual({ id: 'green', name: 'Chair Walter Green', label: 'Green' });
      expect(audit.recordAuditEntry).toHaveBeenCalled();
    });

    it('refuses an item that is already a child of another parent', async () => {
      const member: any = {
        id: 'green',
        name: 'Chair Walter Green',
        organization: { id: 'org-1' },
        parent: { id: 'other' },
        children: coll(),
        stores: coll([{ id: 's1' }]),
      };
      withRows(parent(), member);

      await expect(service.addMember('walter', { productId: 'green', label: 'Green' }, actor)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a model as a member — families never nest', async () => {
      const member: any = {
        id: 'other-model',
        name: 'Sofa Marta',
        organization: { id: 'org-1' },
        parent: null,
        children: coll([{ id: 'kid' }]),
        stores: coll([{ id: 's1' }]),
      };
      withRows(parent(), member);

      await expect(service.addMember('walter', { productId: 'other-model', label: 'X' }, actor)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("hides another organization's item behind a 404", async () => {
      const member: any = {
        id: 'foreign',
        name: 'Ajena',
        organization: { id: 'org-2' },
        parent: null,
        children: coll(),
        stores: coll([{ id: 's1' }]),
      };
      withRows(parent(), member);

      await expect(service.addMember('walter', { productId: 'foreign', label: 'X' }, actor)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses a label another version already shows (case-insensitive)', async () => {
      // The clash is decided under the locks, from the row set — the existing
      // version is a row with its parent link, not just a collection entry.
      const existing: any = {
        id: 'green',
        name: 'Chair Walter Green',
        optionLabel: 'Green',
        parent: { id: 'walter' },
      };
      const member: any = {
        id: 'lime',
        name: 'Chair Walter Lime',
        organization: { id: 'org-1' },
        parent: null,
        children: coll(),
        stores: coll([{ id: 's1' }]),
      };
      withRows(parent([existing]), existing, member);

      await expect(service.addMember('walter', { productId: 'lime', label: 'green' }, actor)).rejects.toThrow(
        /already shows as/,
      );
    });
  });

  describe('updateMemberLabel', () => {
    it('renames what the selector shows', async () => {
      const member: any = { id: 'green', name: 'Chair Walter Green', optionLabel: 'Green' };
      withRows(parent([member]));

      const result = await service.updateMemberLabel('walter', 'green', { label: 'Verde' }, actor);

      expect(member.optionLabel).toBe('Verde');
      expect(result.member.label).toBe('Verde');
    });

    it('404s an item that is not a child of this parent', async () => {
      withRows(parent([]));

      await expect(service.updateMemberLabel('walter', 'stranger', { label: 'X' }, actor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('removeMember / dissolve', () => {
    it('releases one version back to a standalone item', async () => {
      const member: any = { id: 'green', name: 'Chair Walter Green', optionLabel: 'Green', parent: { id: 'walter' } };
      withRows(parent([member]), member);

      await service.removeMember('walter', 'green', actor);

      expect(member.parent).toBeNull();
      expect(member.optionLabel).toBeUndefined();
    });

    it('dissolves the whole family, releasing every version', async () => {
      const a: any = { id: 'green', name: 'G', optionLabel: 'Green', parent: { id: 'walter' } };
      const b: any = { id: 'brown', name: 'B', optionLabel: 'Brown', parent: { id: 'walter' } };
      withRows(parent([a, b]), a, b);

      const result = await service.dissolve('walter', actor);

      expect(result.released).toBe(2);
      expect(a.parent).toBeNull();
      expect(b.parent).toBeNull();
    });

    it('refuses to release children from a product that has none', async () => {
      withRows(parent([]));

      await expect(service.dissolve('walter', actor)).rejects.toThrow('no children to release');
    });

    it('refuses managing a family from one of its children', async () => {
      withRows({ ...parent([]), id: 'green', parent: { id: 'real-model' } });

      await expect(service.dissolve('green', actor)).rejects.toThrow(/manage this from the parent product/);
    });
  });
});
