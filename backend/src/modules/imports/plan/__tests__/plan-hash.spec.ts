import { canonicalize, describeShapeDrift, fingerprintSourceShape, hashBatch, hashPlan, PlanInputs } from '../plan-hash';

const base = (): PlanInputs => ({
  organizationId: 'org-1',
  storeId: null,
  importType: 'PRODUCTS',
  salesInventoryMode: null,
  sourceHash: 'a'.repeat(64),
  parserVersion: 'p9-1',
  analyzerVersion: 'a9-1',
  selection: { sheet: 1, headerRow: 1, firstDataRow: 2, lastDataRow: 100 },
  mapping: { 0: 'externalId', 4: 'name', 26: 'price' },
  decisions: { relationships: { inventory: { defaultLocationId: 'loc-1' } }, acknowledged: ['ROW_UNMATCHED'] },
  targetAssumptions: { existingProducts: 12 },
  mutations: [{ type: 'product.create', name: 'Silla' }],
});

describe('canonicalization', () => {
  it('sorts keys recursively so equal plans hash equally regardless of build order', () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('compares scalars as text, so a JSON round trip cannot change the hash', () => {
    expect(JSON.stringify(canonicalize({ n: 1 }))).toBe(JSON.stringify(canonicalize({ n: '1' })));
  });

  it('treats null and undefined alike', () => {
    expect(JSON.stringify(canonicalize({ a: null }))).toBe(JSON.stringify(canonicalize({ a: undefined })));
  });
});

describe('plan hashing', () => {
  it('is stable for the same plan', () => {
    expect(hashPlan(base())).toBe(hashPlan(base()));
  });

  it('is insensitive to the ORDER keys were built in', () => {
    const reordered = { ...base(), mapping: { 26: 'price', 4: 'name', 0: 'externalId' } };
    expect(hashPlan(reordered)).toBe(hashPlan(base()));
  });

  // Each of these is something a reviewer relied on. If any could change
  // without changing the hash, an approval would survive a plan it never saw.
  const mutations: [string, Partial<PlanInputs>][] = [
    ['the source bytes', { sourceHash: 'b'.repeat(64) }],
    ['the parser version', { parserVersion: 'p9-2' }],
    ['the analyzer version', { analyzerVersion: 'a9-2' }],
    ['the selected range', { selection: { sheet: 1, headerRow: 1, firstDataRow: 2, lastDataRow: 99 } }],
    ['the column mapping', { mapping: { 0: 'externalId', 4: 'name', 26: 'cost' } }],
    // The two that were MISSING from the hash entirely, and are the reason
    // this file's coverage was not enough: it exercised the function with a
    // complete input while the only caller passed neither of them.
    [
      'a relationship decision',
      { decisions: { relationships: { inventory: { defaultLocationId: 'loc-2' } }, acknowledged: ['ROW_UNMATCHED'] } },
    ],
    [
      'an acknowledged warning',
      { decisions: { relationships: { inventory: { defaultLocationId: 'loc-1' } }, acknowledged: [] } },
    ],
    ['the target assumptions', { targetAssumptions: { existingProducts: 13 } }],
    ['the proposed mutations', { mutations: [{ type: 'product.create', name: 'Mesa' }] }],
    ['the target store', { storeId: 'store-1' }],
    ['the import type', { importType: 'CATEGORIES' }],
    ['the sales mode', { salesInventoryMode: 'HISTORICAL_RECORD_ONLY' }],
    ['the organization', { organizationId: 'org-2' }],
  ];

  it.each(mutations)('changes when %s changes', (_label, patch) => {
    expect(hashPlan({ ...base(), ...patch })).not.toBe(hashPlan(base()));
  });
});

describe('batch fingerprints', () => {
  it('differ per batch index, so batch 7 cannot be mistaken for batch 8', () => {
    const m = [{ id: 1 }];
    expect(hashBatch('p', 7, m)).not.toBe(hashBatch('p', 8, m));
  });

  it('differ when the batch’s work differs under the same index', () => {
    expect(hashBatch('p', 7, [{ id: 1 }])).not.toBe(hashBatch('p', 7, [{ id: 2 }]));
  });

  it('differ across plans, so a checkpoint cannot be reused by another plan', () => {
    expect(hashBatch('plan-a', 0, [])).not.toBe(hashBatch('plan-b', 0, []));
  });
});

describe('source shape fingerprint', () => {
  it('ignores VALUES, so the same monthly export does not read as drift', () => {
    // Re-confirming a template every month would train people to click through
    // the one screen meant to catch a real change.
    const a = fingerprintSourceShape(['ID', 'Nombre'], ['INTEGER', 'TEXT']);
    const b = fingerprintSourceShape(['ID', 'Nombre'], ['INTEGER', 'TEXT']);
    expect(a).toBe(b);
  });

  it('is case- and whitespace-insensitive on headings', () => {
    expect(fingerprintSourceShape([' id ', 'NOMBRE'], ['INTEGER', 'TEXT'])).toBe(
      fingerprintSourceShape(['ID', 'nombre'], ['INTEGER', 'TEXT']),
    );
  });

  it('changes when a column is added, removed, moved or retyped', () => {
    const baseline = fingerprintSourceShape(['ID', 'Nombre'], ['INTEGER', 'TEXT']);
    expect(fingerprintSourceShape(['ID', 'Nombre', 'Precio'], ['INTEGER', 'TEXT', 'DECIMAL'])).not.toBe(baseline);
    expect(fingerprintSourceShape(['ID'], ['INTEGER'])).not.toBe(baseline);
    expect(fingerprintSourceShape(['Nombre', 'ID'], ['TEXT', 'INTEGER'])).not.toBe(baseline);
    expect(fingerprintSourceShape(['ID', 'Nombre'], ['TEXT', 'TEXT'])).not.toBe(baseline);
  });
});

describe('drift description', () => {
  it('reports no drift for an identical shape', () => {
    const d = describeShapeDrift(['ID', 'Nombre'], ['INTEGER', 'TEXT'], ['ID', 'Nombre'], ['INTEGER', 'TEXT']);
    expect(d.drifted).toBe(false);
  });

  it('names the columns that appeared and vanished', () => {
    const d = describeShapeDrift(
      ['ID', 'Nombre', 'Precio'],
      ['INTEGER', 'TEXT', 'DECIMAL'],
      ['ID', 'Nombre', 'Coste'],
      ['INTEGER', 'TEXT', 'DECIMAL'],
    );
    expect(d.drifted).toBe(true);
    expect(d.added).toEqual(['coste']);
    expect(d.removed).toEqual(['precio']);
  });

  it('detects a reorder even when every column survives', () => {
    // This is the dangerous one: nothing is missing, so a template would apply
    // cleanly and map prices onto names.
    const d = describeShapeDrift(
      ['ID', 'Nombre', 'Precio'],
      ['INTEGER', 'TEXT', 'DECIMAL'],
      ['Nombre', 'ID', 'Precio'],
      ['TEXT', 'INTEGER', 'DECIMAL'],
    );
    expect(d.drifted).toBe(true);
    expect(d.reordered).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports a column whose type changed under the same heading', () => {
    const d = describeShapeDrift(['Precio'], ['DECIMAL'], ['Precio'], ['TEXT']);
    expect(d.retyped).toEqual([{ header: 'precio', was: 'DECIMAL', now: 'TEXT' }]);
    expect(d.drifted).toBe(true);
  });
});
