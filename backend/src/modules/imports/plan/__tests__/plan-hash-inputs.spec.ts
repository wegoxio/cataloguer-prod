import { planHashInputs } from '../plan-hash-inputs';
import { hashPlan, PlanInputs } from '../plan-hash';
import { IMPORT_PIPELINE_VERSION } from '../../shared/import-limits';
import type { TableMapping } from '../../preview/normalized-preview';

/**
 * What `createPlan` actually puts into the hash.
 *
 * `plan-hash.spec.ts` proves the hash FUNCTION covers everything it is given.
 * This proves the CALLER gives it everything — which is the half that was
 * missing, and the half that cost a plan its relationship decisions.
 *
 * The two files are deliberately separate. One is about a pure function's
 * contract; this one is about a specific call honouring it, and the call is
 * where the defect lived.
 */

const mapping: TableMapping = {
  sheet: 'Sheet 1',
  headerRow: 1,
  columns: [
    { columnIndex: 0, header: 'sku', field: 'sku' },
    { columnIndex: 1, header: 'existencias', field: 'stock' },
  ],
};

const base = (): Parameters<typeof planHashInputs>[0] => ({
  organizationId: 'org-1',
  storeId: 'store-1',
  importType: 'PRODUCTS',
  sourceHash: 'a'.repeat(64),
  mapping,
  sample: { firstRowNumber: 2 },
  decisions: {
    relationships: { inventory: { defaultLocationId: 'warehouse-1' } },
    acknowledged: ['ROW_UNMATCHED'],
  },
  targetAssumptions: { sourceShape: 'shape-1' },
});

const hashOf = (over: Partial<Parameters<typeof planHashInputs>[0]> = {}) =>
  hashPlan(planHashInputs({ ...base(), ...over }));

describe('the inputs createPlan hashes', () => {
  it('supplies every field the hash reads', () => {
    const inputs = planHashInputs(base());
    const required: (keyof PlanInputs)[] = [
      'organizationId',
      'storeId',
      'importType',
      'salesInventoryMode',
      'sourceHash',
      'parserVersion',
      'analyzerVersion',
      'selection',
      'mapping',
      'decisions',
      'targetAssumptions',
      'mutations',
    ];
    // `undefined`, not falsy: `storeId` and `mutations` are legitimately null,
    // and that is a stated answer rather than an omission.
    const missing = required.filter((key) => inputs[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('carries the pipeline version rather than leaving it blank', () => {
    const inputs = planHashInputs(base());
    expect(inputs.parserVersion).toBe(IMPORT_PIPELINE_VERSION);
    expect(inputs.analyzerVersion).toBe(IMPORT_PIPELINE_VERSION);
  });

  it('derives the sales mode from the type, so the column and the hash agree', () => {
    expect(planHashInputs(base()).salesInventoryMode).toBeNull();
    expect(planHashInputs({ ...base(), importType: 'HISTORICAL_STORE_SALES' }).salesInventoryMode).toBe(
      'HISTORICAL_RECORD_ONLY',
    );
  });

  it('states that there is no mutation set yet, rather than saying nothing', () => {
    expect(planHashInputs(base()).mutations).toBeNull();
  });

  /*
    The regression, stated as the thing that actually happened.

    Two plans over the same file with the same mapping, differing only in where
    the stock goes, hashed identically — so the second silently resolved to the
    first through the unique index, and a person who changed the destination got
    the old plan with the old destination.
  */
  it('changes when a relationship decision changes', () => {
    const moved = hashOf({
      decisions: {
        relationships: { inventory: { defaultLocationId: 'warehouse-2' } },
        acknowledged: ['ROW_UNMATCHED'],
      },
    });
    expect(moved).not.toBe(hashOf());
  });

  it('changes when a relationship decision is removed entirely', () => {
    expect(hashOf({ decisions: { relationships: {}, acknowledged: ['ROW_UNMATCHED'] } })).not.toBe(hashOf());
  });

  it('changes when an acknowledged warning changes', () => {
    // An acknowledgement is somebody accepting a specific risk. A plan that
    // accepted a different one is a different plan.
    expect(hashOf({ decisions: { ...base().decisions, acknowledged: [] } })).not.toBe(hashOf());
  });

  it('changes when the header row changes, though the columns are identical', () => {
    // Column indices mean different things under a different header row.
    expect(hashOf({ mapping: { ...mapping, headerRow: 3 } })).not.toBe(hashOf());
  });

  it('changes when the sheet changes', () => {
    expect(hashOf({ mapping: { ...mapping, sheet: 'Sheet 2' } })).not.toBe(hashOf());
  });

  it('changes when the first data row changes', () => {
    expect(hashOf({ sample: { firstRowNumber: 5 } })).not.toBe(hashOf());
  });

  it('changes when the organization changes', () => {
    // The unique index is per organization, so this cannot cross tenants on its
    // own — but a hash that ignored the tenant made that index the only thing
    // standing between two companies' plans.
    expect(hashOf({ organizationId: 'org-2' })).not.toBe(hashOf());
  });

  it('changes when the shape the plan assumed changes', () => {
    expect(hashOf({ targetAssumptions: { sourceShape: 'shape-2' } })).not.toBe(hashOf());
  });

  it('changes when the store, type, source bytes or mapping change', () => {
    expect(hashOf({ storeId: 'store-2' })).not.toBe(hashOf());
    expect(hashOf({ storeId: null })).not.toBe(hashOf());
    expect(hashOf({ importType: 'CATEGORIES' })).not.toBe(hashOf());
    expect(hashOf({ sourceHash: 'b'.repeat(64) })).not.toBe(hashOf());
    expect(hashOf({ mapping: { ...mapping, columns: [mapping.columns[0]] } })).not.toBe(hashOf());
  });

  it('is stable for identical decisions, so re-submitting the same screen is idempotent', () => {
    expect(hashOf()).toBe(hashOf());
    // And insensitive to the order the decision keys were built in, which is
    // what makes the idempotency survive a JSON round trip.
    expect(
      hashOf({
        decisions: {
          acknowledged: ['ROW_UNMATCHED'],
          relationships: { inventory: { defaultLocationId: 'warehouse-1' } },
        },
      }),
    ).toBe(hashOf());
  });
});

describe('refusing to hash an incomplete plan', () => {
  it('throws rather than hashing a field nobody supplied', () => {
    // The failure mode the `as never` cast produced: absent fields
    // canonicalised to null and hashed as though they had been answered.
    const inputs = planHashInputs(base());
    delete (inputs as Partial<PlanInputs>).decisions;
    expect(() => hashPlan(inputs)).toThrow(/decisions/);
  });

  it('names every missing field at once, not just the first', () => {
    const inputs = planHashInputs(base());
    delete (inputs as Partial<PlanInputs>).selection;
    delete (inputs as Partial<PlanInputs>).parserVersion;
    expect(() => hashPlan(inputs)).toThrow(/parserVersion/);
    expect(() => hashPlan(inputs)).toThrow(/selection/);
  });

  it('accepts a deliberate null, because null is an answer', () => {
    expect(() => hashPlan({ ...planHashInputs(base()), storeId: null, mutations: null })).not.toThrow();
  });
});
