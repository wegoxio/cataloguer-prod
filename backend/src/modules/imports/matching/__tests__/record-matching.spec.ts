import {
  CandidateRecord,
  MatchLookups,
  findInternalDuplicates,
  matchRow,
  normalizeIdentityText,
} from '../record-matching';

const product = (over: Partial<CandidateRecord> = {}): CandidateRecord => ({
  id: 'prod-1',
  sku: 'A-1',
  manufacturerCode: null,
  name: 'Silla',
  categoryKey: null,
  ...over,
});

/** Lookups that find nothing unless a test says otherwise. */
const lookups = (over: Partial<MatchLookups> = {}): MatchLookups => ({
  byPriorSourceIdentity: () => null,
  bySku: () => null,
  byManufacturerCode: () => [],
  byNormalizedIdentity: () => [],
  ...over,
});

describe('identity normalization', () => {
  it('folds case, accents and whitespace for NAME comparison', () => {
    expect(normalizeIdentityText('  Sofá   Sabot ')).toBe('sofa sabot');
  });
});

describe('matching priority', () => {
  it('prefers a prior source identity above everything else', () => {
    // The only key the real WooCommerce export carries, since all 841 of its
    // SKUs are blank.
    const r = matchRow({ externalId: '1234' }, lookups({ byPriorSourceIdentity: () => 'prod-prior' }));
    expect(r.decision).toBe('UPDATE');
    expect(r.targetId).toBe('prod-prior');
    expect(r.provenance).toBe('PRIOR_SOURCE_IDENTITY');
  });

  it('outranks a live SKU that names a DIFFERENT product from the same identifier', () => {
    // The card case. A family card gives its SKU up at commit, which frees the
    // string for anything else to take; if the SKU were tried first, the next
    // product to reuse it would capture a re-import of the file that has
    // always meant the card.
    const r = matchRow(
      { sku: 'FAM-P' },
      lookups({ byPriorSourceIdentity: () => 'the-card', bySku: () => product({ id: 'someone-else' }) }),
    );
    expect(r.decision).toBe('UPDATE');
    expect(r.targetId).toBe('the-card');
    expect(r.provenance).toBe('PRIOR_SOURCE_IDENTITY');
  });

  it("FAILS CLOSED when the row's own two identifiers name two different products", () => {
    // An external id AND a separate SKU, pointing at different records: the row
    // disagrees with itself, and choosing either silently is how an import
    // rewrites the wrong one.
    const r = matchRow(
      { externalId: '1234', sku: 'A-1' },
      lookups({ byPriorSourceIdentity: () => 'prod-prior', bySku: () => product({ id: 'prod-sku' }) }),
    );
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.targetId).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/name two different products/i);
    expect(r.ambiguousCandidates?.map((c) => c.id).sort()).toEqual(['prod-prior', 'prod-sku']);
  });

  it('FAILS CLOSED on a mapping whose target is no longer a live product here', () => {
    // A broken pointer is not the same as no pointer. Falling through to the
    // SKU would create or modify a different record on the strength of it.
    const r = matchRow(
      { sku: 'FAM-P' },
      lookups({
        byPriorSourceIdentity: () => null,
        priorSourceIdentityInvalid: () => true,
        bySku: () => product({ id: 'someone-else' }),
      }),
    );
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.targetId).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/no longer exists/i);
  });

  it('falls to internal SKU when no earlier import produced this row', () => {
    const r = matchRow({ externalId: '99', sku: 'A-1' }, lookups({ bySku: () => product() }));
    expect(r.provenance).toBe('INTERNAL_SKU');
    expect(r.reasons.join(' ')).toMatch(/no earlier import of this source produced a record for 99/);
  });

  it('matches SKU case-SENSITIVELY, because the unique index does', () => {
    // Matching case-insensitively would propose an update the database then
    // refuses as a duplicate.
    const bySku = (sku: string) => (sku === 'A-1' ? product() : null);
    expect(matchRow({ sku: 'a-1' }, lookups({ bySku })).decision).toBe('CREATE');
    expect(matchRow({ sku: 'A-1' }, lookups({ bySku })).decision).toBe('UPDATE');
  });

  it('lets a user selection outrank every heuristic', () => {
    const r = matchRow({ externalId: '1234' }, lookups({ byPriorSourceIdentity: () => 'prod-prior' }), {
      userSelection: 'prod-chosen',
    });
    expect(r.targetId).toBe('prod-chosen');
    expect(r.provenance).toBe('USER_SELECTED');
  });
});

describe('manufacturer code', () => {
  it('matches when the code resolves to exactly one product', () => {
    const r = matchRow({ manufacturerCode: 'MFG-9' }, lookups({ byManufacturerCode: () => [product()] }));
    expect(r.decision).toBe('UPDATE');
    expect(r.provenance).toBe('MANUFACTURER_CODE');
  });

  it('REFUSES to choose when two products share the code', () => {
    // A supplier code is not unique by design, and picking one would silently
    // overwrite the wrong product.
    const r = matchRow(
      { manufacturerCode: 'MFG-9' },
      lookups({ byManufacturerCode: () => [product({ id: 'a' }), product({ id: 'b', name: 'Mesa' })] }),
    );
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.targetId).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/used by 2 products, so it cannot identify one/);
    expect(r.ambiguousCandidates?.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('never lets a manufacturer code become an internal SKU', () => {
    // The two identities stay separate: matching on a supplier's code must not
    // imply the product's own SKU.
    const r = matchRow(
      { manufacturerCode: 'MFG-9' },
      lookups({ byManufacturerCode: () => [product({ sku: 'OURS-1' })] }),
    );
    expect(r.provenance).toBe('MANUFACTURER_CODE');
    expect(r.reasons.join(' ')).not.toMatch(/SKU/);
  });
});

describe('name matching is a proposal, never an action', () => {
  it('does not update on a single name match — it asks', () => {
    const r = matchRow({ name: 'Silla' }, lookups({ byNormalizedIdentity: () => [product()] }));
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.provenance).toBe('NORMALIZED_IDENTITY');
    expect(r.reasons.join(' ')).toMatch(/confirm whether this is the same product/);
  });

  it('refuses outright when several products share the name', () => {
    // The real export has six duplicate names.
    const r = matchRow(
      { name: 'Silla Repetida' },
      lookups({ byNormalizedIdentity: () => [product({ id: 'a' }), product({ id: 'b' })] }),
    );
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.reasons.join(' ')).toMatch(/2 existing products share this name/);
  });

  it('mentions the category when one was supplied', () => {
    const r = matchRow(
      { name: 'Silla', categoryKey: 'mobiliario>sillas' },
      lookups({ byNormalizedIdentity: () => [product()] }),
    );
    expect(r.reasons.join(' ')).toMatch(/same name and category/);
  });
});

describe('creating', () => {
  it('creates when nothing existing matches, and says what it tried', () => {
    const r = matchRow({ sku: 'NEW-1', name: 'Nueva' }, lookups());
    expect(r.decision).toBe('CREATE');
    expect(r.reasons.join(' ')).toMatch(/SKU "NEW-1" is not in use yet/);
    expect(r.reasons.join(' ')).toMatch(/nothing existing matches/);
  });

  it('refuses a row carrying nothing that could identify a product', () => {
    const r = matchRow({}, lookups());
    expect(r.decision).toBe('UNRESOLVED');
    expect(r.reasons).toContain('the row carries nothing that could identify a product');
  });
});

describe('duplicates within one import', () => {
  it('finds two rows sharing a SKU before execution rather than mid-batch', () => {
    // Otherwise the second silently overwrites the first, or the batch fails
    // halfway and leaves the import partly applied.
    const dupes = findInternalDuplicates([
      { rowNumber: 2, identity: { sku: 'A-1' } },
      { rowNumber: 5, identity: { sku: 'A-1' } },
      { rowNumber: 7, identity: { sku: 'B-2' } },
    ]);
    expect(dupes).toEqual([{ key: 'A-1', field: 'sku', rows: [2, 5] }]);
  });

  it('finds duplicate external ids', () => {
    const dupes = findInternalDuplicates([
      { rowNumber: 2, identity: { externalId: '10' } },
      { rowNumber: 3, identity: { externalId: '10' } },
    ]);
    expect(dupes[0]).toMatchObject({ field: 'externalId', rows: [2, 3] });
  });

  it('does NOT flag a repeated manufacturer code, which is legitimate', () => {
    // Flagging it would bury the real duplicates in noise.
    expect(
      findInternalDuplicates([
        { rowNumber: 2, identity: { manufacturerCode: 'MFG-9' } },
        { rowNumber: 3, identity: { manufacturerCode: 'MFG-9' } },
      ]),
    ).toEqual([]);
  });

  it('ignores blank identifiers, so 841 empty SKUs are not one giant duplicate', () => {
    expect(
      findInternalDuplicates([
        { rowNumber: 2, identity: { sku: '' } },
        { rowNumber: 3, identity: { sku: null } },
        { rowNumber: 4, identity: { sku: '   ' } },
      ]),
    ).toEqual([]);
  });

  it('reports duplicates in source order', () => {
    const dupes = findInternalDuplicates([
      { rowNumber: 9, identity: { sku: 'Z' } },
      { rowNumber: 2, identity: { sku: 'A' } },
      { rowNumber: 3, identity: { sku: 'A' } },
      { rowNumber: 10, identity: { sku: 'Z' } },
    ]);
    expect(dupes.map((d) => d.key)).toEqual(['A', 'Z']);
  });
});
