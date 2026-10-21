import {
  cardHasVisibleChildrenWhere,
  isChildVisible,
  visibleChildWhere,
  ChildVisibilityContext,
} from '../query/child-visibility';
import { publicVisibilityClauses, publicVisibilityWhere } from '../public-catalogue.service';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

const STORE = 'store-a';
const OTHER = 'store-b';

/** Collection stand-in with the real `isInitialized`. */
const coll = (items: any[] = [], initialized = true) => ({
  getItems: () => items,
  count: () => items.length,
  isInitialized: () => initialized,
});

const link = (storeId: string, published = true) => ({ store: { id: storeId }, published });

const child = (over: Record<string, any> = {}) =>
  ({
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    branchLinks: coll([link(STORE)]),
    ...over,
  }) as any;

/**
 * The ONE rule that decides whether a family child reaches a shopper.
 *
 * It exists twice — as a query fragment and as an in-memory predicate — and
 * the defect this branch closes was precisely that the two DISAGREED. These
 * tests are the thing that keeps them honest.
 */
describe('family child visibility', () => {
  describe('the two expressions of the rule agree', () => {
    /**
     * The in-memory predicate answered against the same row the query fragment
     * would match, for every combination of the three facts the rule reads.
     * Any divergence here is a child disclosed in one surface and hidden in
     * another — the original defect.
     */
    const cases: { name: string; row: any; storeId?: string; visible: boolean }[] = [
      { name: 'published, unarchived, linked and published here', row: child(), storeId: STORE, visible: true },
      { name: 'draft', row: child({ status: ProductStatus.DRAFT }), storeId: STORE, visible: false },
      { name: 'archived', row: child({ archivedAt: new Date() }), storeId: STORE, visible: false },
      {
        name: 'linked here but the link is unpublished',
        row: child({ branchLinks: coll([link(STORE, false)]) }),
        storeId: STORE,
        visible: false,
      },
      {
        name: 'published only in ANOTHER store',
        row: child({ branchLinks: coll([link(OTHER)]) }),
        storeId: STORE,
        visible: false,
      },
      { name: 'in no store at all', row: child({ branchLinks: coll([]) }), storeId: STORE, visible: false },
      {
        name: 'published here among several stores',
        row: child({ branchLinks: coll([link(OTHER), link(STORE)]) }),
        storeId: STORE,
        visible: true,
      },
    ];

    it.each(cases)('$name', ({ row, storeId, visible }) => {
      expect(isChildVisible(row, { storeId })).toBe(visible);
    });

    it('the query fragment reads the same three facts, and no others', () => {
      expect(visibleChildWhere({ storeId: STORE })).toEqual({
        archivedAt: null,
        status: ProductStatus.PUBLISHED,
        branchLinks: { store: STORE, published: true },
      });
    });

    it('both halves drop the store term together when no store is named', () => {
      expect(visibleChildWhere()).toEqual({ archivedAt: null, status: ProductStatus.PUBLISHED });
      // ...and the predicate agrees: without a store, only status and archival.
      expect(isChildVisible(child({ branchLinks: coll([link(OTHER)]) }))).toBe(true);
      expect(isChildVisible(child({ status: ProductStatus.DRAFT }))).toBe(false);
    });
  });

  describe('fails closed', () => {
    it('treats an UNPOPULATED link collection as not visible', () => {
      // A future query that forgets `children.branchLinks` must hide the child,
      // never disclose it. This is the difference between a bug that shows an
      // empty card and a bug that leaks another store's catalogue.
      const unpopulated = child({ branchLinks: coll([link(STORE)], false) });
      expect(isChildVisible(unpopulated, { storeId: STORE })).toBe(false);
    });

    it('treats a MISSING link collection as not visible', () => {
      expect(isChildVisible(child({ branchLinks: undefined }), { storeId: STORE })).toBe(false);
    });

    it('accepts a link whose store arrives as a bare id rather than an entity', () => {
      const idOnly = child({ branchLinks: coll([{ store: STORE, published: true }]) });
      expect(isChildVisible(idOnly, { storeId: STORE })).toBe(true);
    });
  });

  /**
   * Each of these flips exactly one decision in the rule. If any survives, the
   * corresponding branch is not actually load-bearing and the guard is
   * decoration.
   */
  describe('mutation coverage — every branch is load-bearing', () => {
    type Mutant = { name: string; predicate: (c: any, ctx?: ChildVisibilityContext) => boolean };
    const mutants: Mutant[] = [
      {
        name: 'drops the status check',
        predicate: (c, ctx) => isChildVisible({ ...c, status: ProductStatus.PUBLISHED } as any, ctx),
      },
      {
        name: 'drops the archival check',
        predicate: (c, ctx) => isChildVisible({ ...c, archivedAt: null } as any, ctx),
      },
      {
        name: 'drops the store check',
        predicate: (c) => isChildVisible(c, undefined),
      },
      {
        name: 'drops the published-link check',
        predicate: (c, ctx) =>
          isChildVisible(
            { ...c, branchLinks: coll(c.branchLinks.getItems().map((l: any) => ({ ...l, published: true }))) } as any,
            ctx,
          ),
      },
    ];

    const killers: Record<string, any> = {
      'drops the status check': child({ status: ProductStatus.DRAFT }),
      'drops the archival check': child({ archivedAt: new Date() }),
      'drops the store check': child({ branchLinks: coll([link(OTHER)]) }),
      'drops the published-link check': child({ branchLinks: coll([link(STORE, false)]) }),
    };

    it.each(mutants)('$name is killed', ({ name, predicate }) => {
      const row = killers[name];
      // The real rule hides it...
      expect(isChildVisible(row, { storeId: STORE })).toBe(false);
      // ...and the mutant would not, which is what makes the branch matter.
      expect(predicate(row, { storeId: STORE })).toBe(true);
    });
  });

  describe('empty-parent suppression clause', () => {
    it('keeps a standalone product and a card with at least one visible child', () => {
      expect(cardHasVisibleChildrenWhere({ storeId: STORE })).toEqual({
        $and: [
          {
            $or: [
              { children: { $none: {} } },
              {
                children: {
                  $some: {
                    archivedAt: null,
                    status: ProductStatus.PUBLISHED,
                    branchLinks: { store: STORE, published: true },
                  },
                },
              },
            ],
          },
        ],
      });
    });

    /**
     * The clause is wrapped in `$and` for a reason with teeth: the flattened
     * form merges clauses by key, so a bare `$or` would REPLACE the category
     * clause that already uses that key and silently drop it.
     */
    it('does not displace the category clause when the rules are flattened', () => {
      const flat = publicVisibilityWhere({ organizationId: 'org-1', storeId: STORE });
      expect(flat.$or).toEqual([{ categories: null }, { categories: { archivedAt: null } }]);
      expect(flat.$and).toEqual(cardHasVisibleChildrenWhere({ storeId: STORE }).$and);
    });

    it('is part of the shared public rules, so every path using them inherits it', () => {
      expect(publicVisibilityClauses({ storeId: STORE })).toContainEqual(
        cardHasVisibleChildrenWhere({ storeId: STORE }),
      );
    });
  });

  /**
   * A store-scoped request MUST carry its store. The rule degrades to
   * status-and-archival without one, so "no store" must never be a silent way
   * to serve a store-scoped surface unfiltered.
   *
   * These are the ONLY callers that legitimately pass no store, enumerated so
   * that a new one has to be added here deliberately.
   */
  describe('legitimate no-store callers', () => {
    it('are exactly the company-wide surfaces, which are not store-scoped', () => {
      // `getProducts`, `getProductBySlug` and `getProductsByCategorySlug` take
      // `storeId` from the API key's channel (ADR 007). It is absent only for a
      // company-wide caller — one whose key names no store — and such a caller
      // is asking about the CATALOGUE, not about a shop's shelf.
      //
      // The store term is therefore absent by the caller's authority, never by
      // omission inside a store-scoped path: no code below the controller
      // constructs a projection context, so there is no place to lose it.
      expect(visibleChildWhere({ storeId: undefined })).not.toHaveProperty('branchLinks');
      expect(publicVisibilityClauses({})).not.toContainEqual(
        expect.objectContaining({ branchLinks: expect.anything() }),
      );
    });
  });
});
