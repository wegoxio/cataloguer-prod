import {
  InventoryContext,
  ParsedInventoryIntent,
  classifyDiscrepancy,
  classifyInventoryIntents,
  describeProposal,
  isZeroDecision,
  proposalIdempotencyKey,
} from '../inventory-proposal';

/**
 * What an import may say about stock.
 *
 * The ledger owns what is in stock, so an import proposes rather than writes.
 * Every refusal here is a case where posting would put a number in the ledger
 * that nobody could later account for — and an unaccountable number makes every
 * subsequent question about that product unanswerable.
 */

const STORE_A = 'store-a';
const STORE_B = 'store-b';

const context = (over: Partial<InventoryContext> = {}): InventoryContext => ({
  allowedStoreIds: new Set([STORE_A, STORE_B]),
  storeLocationIds: new Map([
    [STORE_A, 'loc-a'],
    [STORE_B, 'loc-b'],
  ]),
  frozen: false,
  hasDefaultWarehouse: true,
  ...over,
});

const intent = (over: Partial<ParsedInventoryIntent> = {}): ParsedInventoryIntent => ({
  sourceRow: 2,
  productId: 'product-1',
  ...over,
});

describe('how a declared total relates to its breakdown', () => {
  it('says nothing when the file said nothing', () => {
    expect(classifyDiscrepancy(intent())).toBe('NOTHING_STATED');
  });

  it('recognises a total with no breakdown', () => {
    expect(classifyDiscrepancy(intent({ organizationTotal: 40 }))).toBe('PRODUCT_ONLY');
  });

  it('recognises a breakdown with no total', () => {
    expect(classifyDiscrepancy(intent({ allocations: [{ storeId: STORE_A, quantity: 10, condition: 'GOOD' }] }))).toBe(
      'ALLOCATION_ONLY',
    );
  });

  it('recognises the two agreeing', () => {
    expect(
      classifyDiscrepancy(
        intent({
          organizationTotal: 10,
          allocations: [{ storeId: STORE_A, quantity: 10, condition: 'GOOD' }],
        }),
      ),
    ).toBe('MATCHED');
  });

  it('recognises the two disagreeing', () => {
    expect(
      classifyDiscrepancy(
        intent({
          organizationTotal: 40,
          allocations: [{ storeId: STORE_A, quantity: 10, condition: 'GOOD' }],
        }),
      ),
    ).toBe('DIVERGENT');
  });
});

describe('classifying an importable intent', () => {
  it('proposes an adjustment placing every unit', () => {
    const { proposals, refusals } = classifyInventoryIntents(
      [
        intent({
          organizationTotal: 15,
          allocations: [
            { storeId: STORE_A, quantity: 10, condition: 'GOOD' },
            { storeId: STORE_B, quantity: 5, condition: 'GOOD' },
          ],
        }),
      ],
      context(),
    );

    expect(refusals).toEqual([]);
    expect(proposals[0]).toMatchObject({ kind: 'OPENING_ADJUSTMENT', discrepancy: 'MATCHED', totalQuantity: 15 });
    expect(proposals[0].placements).toEqual([
      { locationId: 'loc-a', condition: 'GOOD', quantity: 10 },
      { locationId: 'loc-b', condition: 'GOOD', quantity: 5 },
    ]);
  });

  it('keeps damaged units in their own bucket', () => {
    // Condition is stated, never assumed, because DAMAGED units are owned and
    // not sellable.
    const { proposals } = classifyInventoryIntents(
      [
        intent({
          allocations: [
            { storeId: STORE_A, quantity: 8, condition: 'GOOD' },
            { storeId: STORE_A, quantity: 2, condition: 'DAMAGED' },
          ],
        }),
      ],
      context(),
    );
    expect(proposals[0].placements).toEqual([
      { locationId: 'loc-a', condition: 'GOOD', quantity: 8 },
      { locationId: 'loc-a', condition: 'DAMAGED', quantity: 2 },
    ]);
  });

  it('sends the unallocated remainder to the stated destination', () => {
    // Units have to be somewhere, and the destination was named.
    const { proposals } = classifyInventoryIntents(
      [
        intent({
          organizationTotal: 20,
          allocations: [{ storeId: STORE_A, quantity: 12, condition: 'GOOD' }],
          defaultLocationId: 'warehouse-1',
        }),
      ],
      context(),
    );
    expect(proposals[0].discrepancy).toBe('DIVERGENT');
    expect(proposals[0].placements).toContainEqual({ locationId: 'warehouse-1', condition: 'GOOD', quantity: 8 });
  });

  it('ignores a row that said nothing about stock', () => {
    const { proposals, refusals } = classifyInventoryIntents([intent()], context());
    expect(proposals).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it('classifies a receipt proposal as a receipt', () => {
    const { proposals } = classifyInventoryIntents(
      [intent({ allocations: [{ storeId: STORE_A, quantity: 5, condition: 'GOOD' }] })],
      context(),
      'RECEIPT',
    );
    expect(proposals[0].kind).toBe('RECEIPT');
  });
});

describe('a declared zero is a decision', () => {
  it('is recognised rather than treated as an absence', () => {
    // "This product has none" is a statement the customer made. Dropping it
    // would leave a stale cache and an unanswered question.
    expect(isZeroDecision(intent({ organizationTotal: 0 }))).toBe(true);
    expect(isZeroDecision(intent({ allocations: [{ storeId: STORE_A, quantity: 0, condition: 'GOOD' }] }))).toBe(true);
  });

  it('is not confused with a row that said nothing', () => {
    expect(isZeroDecision(intent())).toBe(false);
  });

  it('is carried through as a proposal that moves nothing', () => {
    const { proposals } = classifyInventoryIntents([intent({ organizationTotal: 0 })], context());
    expect(proposals[0]).toMatchObject({ zeroDecision: true, totalQuantity: 0 });
    expect(proposals[0].placements).toEqual([]);
  });

  it('describes itself in the approver’s words', () => {
    const { proposals } = classifyInventoryIntents([intent({ organizationTotal: 0 })], context());
    expect(describeProposal(proposals[0])).toBe('Record that this product holds nothing.');
  });
});

describe('what will not become a ledger entry', () => {
  it('REFUSES units the row leaves with nowhere to be', () => {
    // 10 of 40 in shops and no destination for the other 30. Reconciliation is
    // about every unit being ACCOUNTED FOR, not about the two numbers matching.
    const { proposals, refusals } = classifyInventoryIntents(
      [
        intent({
          organizationTotal: 40,
          allocations: [{ storeId: STORE_A, quantity: 10, condition: 'GOOD' }],
        }),
      ],
      context(),
    );
    expect(proposals).toEqual([]);
    expect(refusals[0].issue.message).toBe('This row leaves 30 unit(s) unaccounted for: the shops hold 10 of 40.');
    expect(refusals[0].issue.guidance).toMatch(/Choose a destination/);
  });

  it('REFUSES shops that already hold MORE than the declared total', () => {
    // A contradiction with no defensible resolution. A silent max, min or sum
    // is exactly what the opening-reconciliation decision forbids.
    const { proposals, refusals } = classifyInventoryIntents(
      [
        intent({
          organizationTotal: 10,
          allocations: [{ storeId: STORE_A, quantity: 25, condition: 'GOOD' }],
        }),
      ],
      context(),
    );
    expect(proposals).toEqual([]);
    expect(refusals[0].issue.message).toBe('This row says the company holds 10 but the shops already account for 25.');
    expect(refusals[0].issue.guidance).toMatch(/do not exceed it/);
  });

  it('REFUSES a total with nowhere to put it', () => {
    // Custody is a decision; defaulting it would put stock in a shop nobody
    // named.
    const { refusals } = classifyInventoryIntents([intent({ organizationTotal: 40 })], context());
    expect(refusals[0].issue.message).toMatch(/does not say where the stock is held/);
  });

  it('accepts a total WITH a destination', () => {
    const { proposals, refusals } = classifyInventoryIntents(
      [intent({ organizationTotal: 40, defaultLocationId: 'warehouse-1' })],
      context(),
    );
    expect(refusals).toEqual([]);
    expect(proposals[0].placements).toEqual([{ locationId: 'warehouse-1', condition: 'GOOD', quantity: 40 }]);
  });

  it('REFUSES a shop outside the caller’s scope, indistinguishably from one that does not exist', () => {
    const { refusals } = classifyInventoryIntents(
      [intent({ allocations: [{ storeId: 'someone-elses-shop', quantity: 5, condition: 'GOOD' }] })],
      context(),
    );
    expect(refusals[0].issue.code).toBe('STORE_NOT_PERMITTED');
    expect(refusals[0].issue.message).toBe('One of the shops in this row is not available to you.');
  });

  it('REFUSES a shop with no stock location set up', () => {
    const { refusals } = classifyInventoryIntents(
      [intent({ allocations: [{ storeId: STORE_B, quantity: 5, condition: 'GOOD' }] })],
      context({ storeLocationIds: new Map([[STORE_A, 'loc-a']]) }),
    );
    expect(refusals[0].issue.message).toMatch(/no stock location set up/);
  });

  it('REFUSES a negative quantity', () => {
    const { refusals } = classifyInventoryIntents(
      [intent({ allocations: [{ storeId: STORE_A, quantity: -3, condition: 'GOOD' }] })],
      context(),
    );
    expect(refusals[0].issue.message).toMatch(/negative quantity/);
  });

  it('REFUSES when the company has no main warehouse', () => {
    // The posting surface requires exactly one and refuses otherwise. Catching
    // it here gives a row-level sentence instead of a whole batch failing on an
    // operator-facing exception.
    const { proposals, refusals } = classifyInventoryIntents(
      [intent({ organizationTotal: 5, defaultLocationId: 'warehouse-1' })],
      context({ hasDefaultWarehouse: false }),
    );
    expect(proposals).toEqual([]);
    expect(refusals[0].issue.message).toMatch(/no main warehouse/);
    expect(refusals[0].issue.guidance).toMatch(/Set up your inventory locations/);
  });

  it('REFUSES everything while the company is in a cutover window', () => {
    // The freeze exists precisely because no ordinary caller should be posting.
    const { proposals, refusals } = classifyInventoryIntents(
      [intent({ organizationTotal: 5, defaultLocationId: 'warehouse-1' })],
      context({ frozen: true }),
    );
    expect(proposals).toEqual([]);
    expect(refusals[0].issue.message).toMatch(/cutover window/);
    expect(refusals[0].issue.guidance).toMatch(/Wait until the cutover finishes/);
  });

  it('accounts for every intent, as a proposal or a refusal', () => {
    // A silently discarded stock intent is a customer believing their inventory
    // was imported.
    const intents = [
      intent({ sourceRow: 2, organizationTotal: 5, defaultLocationId: 'w' }),
      intent({
        sourceRow: 3,
        organizationTotal: 40,
        allocations: [{ storeId: STORE_A, quantity: 1, condition: 'GOOD' }],
      }),
      intent({ sourceRow: 4, allocations: [{ storeId: 'nope', quantity: 1, condition: 'GOOD' }] }),
    ];
    const { proposals, refusals } = classifyInventoryIntents(intents, context());
    const accounted = [...proposals.map((p) => p.sourceRow), ...refusals.map((r) => r.sourceRow)].sort();
    expect(accounted).toEqual([2, 3, 4]);
  });
});

describe('idempotency', () => {
  it('binds a posting to its execution and source row', () => {
    // A resumed or retried run replays the posting rather than doubling it.
    const key = proposalIdempotencyKey('exec-1', 42, 'product-9');
    expect(key).toBe('import:exec-1:42:product-9');
    expect(proposalIdempotencyKey('exec-2', 42, 'product-9')).not.toBe(key);
    expect(proposalIdempotencyKey('exec-1', 43, 'product-9')).not.toBe(key);
  });
});

describe('what the approver reads', () => {
  it('says what the proposal would do, in units', () => {
    const { proposals } = classifyInventoryIntents(
      [
        intent({
          allocations: [
            { storeId: STORE_A, quantity: 10, condition: 'GOOD' },
            { storeId: STORE_B, quantity: 5, condition: 'GOOD' },
          ],
        }),
      ],
      context(),
    );
    expect(describeProposal(proposals[0])).toBe('Adjust the ledger by 15 units across 2 locations.');
  });

  it('says "Receive" for a receipt', () => {
    const { proposals } = classifyInventoryIntents(
      [intent({ allocations: [{ storeId: STORE_A, quantity: 1, condition: 'GOOD' }] })],
      context(),
      'RECEIPT',
    );
    expect(describeProposal(proposals[0])).toBe('Receive 1 unit in one location.');
  });
});
