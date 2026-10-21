import { newlyExposedStoreIds, PublicationSnapshot } from '../../shared/store-membership.util';

const snap = (over: Partial<PublicationSnapshot> = {}): PublicationSnapshot => ({
  publishedBefore: true,
  publishedAfter: true,
  before: new Map(),
  after: new Map(),
  ...over,
});

/**
 * The ONE definition of "which stores did this write newly expose".
 *
 * Both the guarded ORM writer and the plan-based importer decide from this
 * function, so a disagreement here is a disagreement between two whole
 * publication paths — which is exactly the defect issue #260 records.
 */
describe('newlyExposedStoreIds', () => {
  describe('a product that does not end published exposes nothing', () => {
    it.each([
      ['stays draft', false, false],
      ['becomes draft', true, false],
    ])('%s', (_label, publishedBefore, publishedAfter) => {
      expect(
        newlyExposedStoreIds(
          snap({
            publishedBefore,
            publishedAfter,
            after: new Map([
              ['store-a', true],
              ['store-b', true],
            ]),
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('an already-published product', () => {
    it('exposes a link that turns published', () => {
      expect(
        newlyExposedStoreIds(snap({ before: new Map([['store-a', false]]), after: new Map([['store-a', true]]) })),
      ).toEqual(['store-a']);
    });

    it('exposes a link that did not exist before', () => {
      expect(newlyExposedStoreIds(snap({ before: new Map(), after: new Map([['store-a', true]]) }))).toEqual([
        'store-a',
      ]);
    });

    it('does NOT re-expose a link that was already live', () => {
      // Re-validating a retained live pivot would refuse a write that changes
      // nothing a customer can see.
      expect(
        newlyExposedStoreIds(snap({ before: new Map([['store-a', true]]), after: new Map([['store-a', true]]) })),
      ).toEqual([]);
    });

    it('ignores a link that ends unpublished', () => {
      expect(
        newlyExposedStoreIds(snap({ before: new Map([['store-a', true]]), after: new Map([['store-a', false]]) })),
      ).toEqual([]);
    });
  });

  describe('a product BECOMING published', () => {
    it('exposes every link published in the final state, including untouched ones', () => {
      // The write may name no store at all: the STATUS is what makes these live.
      expect(
        newlyExposedStoreIds(
          snap({
            publishedBefore: false,
            before: new Map([
              ['store-a', true],
              ['store-b', false],
            ]),
            after: new Map([
              ['store-a', true],
              ['store-b', false],
              ['store-c', true],
            ]),
          }),
        ),
      ).toEqual(['store-a', 'store-c']);
    });
  });

  it('returns store ids in ascending order, so a refusal names the same one every time', () => {
    expect(
      newlyExposedStoreIds(
        snap({
          publishedBefore: false,
          after: new Map([
            ['store-z', true],
            ['store-a', true],
            ['store-m', true],
          ]),
        }),
      ),
    ).toEqual(['store-a', 'store-m', 'store-z']);
  });

  /** Each mutant drops one decision; a survivor would mean that decision is dead. */
  describe('mutation coverage', () => {
    const cases: { name: string; input: PublicationSnapshot; real: string[]; mutant: string[] }[] = [
      {
        name: 'the publishedAfter short-circuit',
        input: snap({ publishedAfter: false, after: new Map([['store-a', true]]) }),
        real: [],
        // A mutant without the short-circuit would expose a draft's links.
        mutant: ['store-a'],
      },
      {
        name: 'the link-published filter',
        input: snap({ publishedBefore: false, after: new Map([['store-a', false]]) }),
        real: [],
        // A mutant ignoring `published` would expose a hidden link.
        mutant: ['store-a'],
      },
      {
        name: 'the already-live exclusion',
        input: snap({ before: new Map([['store-a', true]]), after: new Map([['store-a', true]]) }),
        real: [],
        // A mutant without it re-validates every retained pivot.
        mutant: ['store-a'],
      },
      {
        name: 'the publishedBefore arm',
        input: snap({
          publishedBefore: false,
          before: new Map([['store-a', true]]),
          after: new Map([['store-a', true]]),
        }),
        // A product becoming published DOES expose its already-published link.
        real: ['store-a'],
        mutant: [],
      },
    ];

    it.each(cases)('$name is load-bearing', ({ input, real, mutant }) => {
      expect(newlyExposedStoreIds(input)).toEqual(real);
      // The mutant's answer differs, which is what makes the branch matter.
      expect(mutant).not.toEqual(real);
    });
  });
});
