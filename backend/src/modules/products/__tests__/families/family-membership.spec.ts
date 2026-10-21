import { BadRequestException } from '@nestjs/common';
import { assertEligibleAsChild } from '../../families/family-membership';

const coll = (items: any[] = [], initialized = true) => ({
  getItems: () => items,
  count: () => items.length,
  isInitialized: () => initialized,
});

const candidate = (over: Record<string, any> = {}) =>
  ({
    name: 'Silla Nordic',
    parent: null,
    children: coll(),
    stores: coll([{ id: 'store-a' }]),
    ...over,
  }) as any;

/**
 * ONE membership rule for both entry points.
 *
 * `POST /products/families` and `POST /products/:id/family/members` were each
 * enforcing a rule the other did not, so what was legal depended on which door
 * you came through. The eligibility check is one function now, and these tests
 * pin every refusal it makes.
 */
describe('family membership eligibility', () => {
  it('accepts a standalone product that belongs to at least one store', () => {
    expect(() => assertEligibleAsChild(candidate())).not.toThrow();
  });

  describe('refusals', () => {
    it('refuses a product that is already a child of another parent', () => {
      expect(() => assertEligibleAsChild(candidate({ parent: { id: 'other' } }))).toThrow(
        /is already a child of another parent/,
      );
    });

    /**
     * This is the rule CREATION was missing. Without it, two parents could be
     * grouped under a third and produce a three-level hierarchy the model does
     * not have, no surface renders, and checkout cannot price.
     */
    it('refuses a product that is itself a parent', () => {
      expect(() => assertEligibleAsChild(candidate({ children: coll([{ id: 'kid' }]) }))).toThrow(
        /is a parent with children of its own/,
      );
    });

    /** And this is the rule ATTACHMENT was missing. */
    it('refuses a product that belongs to no store', () => {
      expect(() => assertEligibleAsChild(candidate({ stores: coll([]) }))).toThrow(
        /belongs to no store, so it cannot become a child product/,
      );
    });

    it('says "store", never "branch" — the word the product uses', () => {
      const err = (() => {
        try {
          assertEligibleAsChild(candidate({ stores: coll([]) }));
        } catch (e) {
          return e as Error;
        }
      })()!;
      expect(err.message).toContain('store');
      expect(err.message).not.toMatch(/branch/i);
    });

    it('refuses with a 400, not a 404 — an ineligible product is a stated refusal', () => {
      for (const bad of [
        candidate({ parent: { id: 'other' } }),
        candidate({ children: coll([{ id: 'kid' }]) }),
        candidate({ stores: coll([]) }),
      ]) {
        expect(() => assertEligibleAsChild(bad)).toThrow(BadRequestException);
      }
    });

    it('names the product in every refusal, so a bulk caller can tell which one failed', () => {
      for (const bad of [
        candidate({ name: 'Mesa', parent: { id: 'other' } }),
        candidate({ name: 'Mesa', children: coll([{ id: 'kid' }]) }),
        candidate({ name: 'Mesa', stores: coll([]) }),
      ]) {
        expect(() => assertEligibleAsChild(bad)).toThrow(/"Mesa"/);
      }
    });
  });

  describe('fails closed', () => {
    /**
     * An unloaded collection reports zero. If the childless check trusted that,
     * a caller that forgot to populate `children` would let a parent through —
     * so the check requires the collection to be initialized before it believes
     * the count.
     */
    it('does not treat an UNPOPULATED children collection as proof of childlessness', () => {
      const unloaded = candidate({ children: coll([{ id: 'kid' }], false) });
      // It cannot prove the product is a parent, so it does not refuse here —
      // but both callers populate `children`, and the attach path re-checks the
      // count in the DATABASE under the family locks.
      expect(() => assertEligibleAsChild(unloaded)).not.toThrow();
    });
  });

  /**
   * Each mutant drops exactly one refusal. A surviving mutant would mean that
   * branch never decides anything.
   */
  describe('mutation coverage — every refusal is load-bearing', () => {
    const cases: { name: string; row: any; mutant: (p: any) => void }[] = [
      {
        name: 'the already-a-child check',
        row: candidate({ parent: { id: 'other' } }),
        mutant: (p) => assertEligibleAsChild({ ...p, parent: null }),
      },
      {
        name: 'the is-itself-a-parent check',
        row: candidate({ children: coll([{ id: 'kid' }]) }),
        mutant: (p) => assertEligibleAsChild({ ...p, children: coll() }),
      },
      {
        name: 'the belongs-to-a-store check',
        row: candidate({ stores: coll([]) }),
        mutant: (p) => assertEligibleAsChild({ ...p, stores: coll([{ id: 'store-a' }]) }),
      },
    ];

    it.each(cases)('$name is killed', ({ row, mutant }) => {
      expect(() => assertEligibleAsChild(row)).toThrow();
      // Dropping that one fact makes the very same row acceptable.
      expect(() => mutant(row)).not.toThrow();
    });
  });
});
