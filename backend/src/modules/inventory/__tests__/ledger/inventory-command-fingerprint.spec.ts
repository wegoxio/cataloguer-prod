import {
  canonicalJson,
  canonicalCommandPayload,
  commandFingerprint,
  movementKey,
  sortMovements,
} from '../../ledger/inventory-command-fingerprint';
import { InventoryCommand } from '../../ledger/inventory.types';

/**
 * The fingerprint is what turns `UNIQUE (organization_id, idempotency_key)` into
 * real idempotency. If a caller can change the digest by reordering properties
 * or lines, a genuine replay looks like a conflict; if a semantic change does
 * NOT change the digest, a different command passes as a replay. Both failures
 * are proved against here.
 */
describe('inventory command fingerprint', () => {
  const base: InventoryCommand = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    type: 'RESERVE',
    idempotencyKey: 'key-1',
    principal: { kind: 'USER', userId: 'u-1', email: 'a@example.com' },
    intents: [{ productId: 'p-1', declaredAmount: 5, intentSign: 0 }],
    movements: [
      {
        productId: 'p-1',
        locationId: 'loc-1',
        physicalCondition: 'GOOD',
        operationalState: 'AVAILABLE',
        quantityDelta: -5,
      },
      {
        productId: 'p-1',
        locationId: 'loc-1',
        physicalCondition: 'GOOD',
        operationalState: 'RESERVED',
        quantityDelta: 5,
      },
    ],
  };

  it('produces 64 lowercase hex characters', () => {
    expect(commandFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across runs', () => {
    expect(commandFingerprint(base)).toBe(commandFingerprint({ ...base }));
  });

  it('ignores the order the caller happened to build movement lines in', () => {
    const reordered: InventoryCommand = { ...base, movements: [base.movements[1], base.movements[0]] };
    expect(commandFingerprint(reordered)).toBe(commandFingerprint(base));
  });

  it('ignores intent line order', () => {
    const two: InventoryCommand = {
      ...base,
      type: 'PRODUCT_STOCK_REASSIGNMENT',
      intents: [
        { productId: 'p-1', declaredAmount: 5, intentSign: -1 },
        { productId: 'p-2', declaredAmount: 5, intentSign: 1 },
      ],
    };
    const flipped: InventoryCommand = { ...two, intents: [two.intents[1], two.intents[0]] };
    expect(commandFingerprint(flipped)).toBe(commandFingerprint(two));
  });

  it('ignores object property order inside a line', () => {
    const rebuilt: InventoryCommand = {
      ...base,
      movements: base.movements.map((line) => ({
        quantityDelta: line.quantityDelta,
        operationalState: line.operationalState,
        physicalCondition: line.physicalCondition,
        locationId: line.locationId,
        productId: line.productId,
      })),
    };
    expect(commandFingerprint(rebuilt)).toBe(commandFingerprint(base));
  });

  it('treats an omitted optional field and an explicit null as the same command', () => {
    const withNulls: InventoryCommand = { ...base, scopeProductId: null, salesOrderId: null };
    expect(commandFingerprint(withNulls)).toBe(commandFingerprint(base));
  });

  it('does NOT depend on the idempotency key, nor on the actor email', () => {
    const other: InventoryCommand = {
      ...base,
      idempotencyKey: 'key-2',
      principal: { kind: 'USER', userId: 'u-1', email: 'changed@example.com' },
    };
    expect(commandFingerprint(other)).toBe(commandFingerprint(base));
  });

  it('DOES depend on the posting principal', () => {
    const otherUser: InventoryCommand = { ...base, principal: { kind: 'USER', userId: 'u-2' } };
    const system: InventoryCommand = { ...base, principal: { kind: 'SYSTEM', origin: 'sales-checkout' } };
    const otherSystem: InventoryCommand = { ...base, principal: { kind: 'SYSTEM', origin: 'supplier-receipt' } };
    expect(commandFingerprint(otherUser)).not.toBe(commandFingerprint(base));
    expect(commandFingerprint(system)).not.toBe(commandFingerprint(base));
    expect(commandFingerprint(otherSystem)).not.toBe(commandFingerprint(system));
  });

  it.each([
    ['a changed quantity', { ...base, movements: [{ ...base.movements[0], quantityDelta: -6 }, base.movements[1]] }],
    ['a changed product', { ...base, movements: [{ ...base.movements[0], productId: 'p-9' }, base.movements[1]] }],
    ['a changed location', { ...base, movements: [{ ...base.movements[0], locationId: 'loc-9' }, base.movements[1]] }],
    [
      'a changed condition',
      { ...base, movements: [{ ...base.movements[0], physicalCondition: 'DAMAGED' as const }, base.movements[1]] },
    ],
    ['a changed type', { ...base, type: 'RELEASE' as const }],
    [
      'a changed declared amount',
      { ...base, intents: [{ productId: 'p-1', declaredAmount: 6, intentSign: 0 as const }] },
    ],
    ['a changed organization', { ...base, organizationId: '22222222-2222-4222-8222-222222222222' }],
    ['a changed scope product', { ...base, scopeProductId: 'p-root' }],
  ])('changes when the command changes: %s', (_label, changed) => {
    expect(commandFingerprint(changed as InventoryCommand)).not.toBe(commandFingerprint(base));
  });

  it('refuses non-integer quantities rather than hashing an unstable number', () => {
    const bad: InventoryCommand = {
      ...base,
      movements: [{ ...base.movements[0], quantityDelta: -5.5 }, base.movements[1]],
    };
    expect(() => commandFingerprint(bad)).toThrow(/integer/i);
  });

  describe('canonical serialization', () => {
    it('sorts keys and omits nulls', () => {
      expect(canonicalJson({ b: 1, a: 2, c: null })).toBe('{"a":2,"b":1}');
    });

    it('emits no insignificant whitespace', () => {
      expect(canonicalJson({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
    });

    it('refuses non-integer numbers', () => {
      expect(() => canonicalJson({ a: 1.5 })).toThrow(/non-integer/i);
    });

    it('keeps array order, which is meaningful only after the line sort', () => {
      expect(canonicalJson([2, 1])).toBe('[2,1]');
    });
  });

  describe('movement key doubles as the projection lock order', () => {
    it('orders deterministically regardless of input order', () => {
      const sorted = sortMovements([base.movements[1], base.movements[0]]).map(movementKey);
      const again = sortMovements([base.movements[0], base.movements[1]]).map(movementKey);
      expect(sorted).toEqual(again);
    });

    it('distinguishes a transit line from a located line', () => {
      const transit = movementKey({
        productId: 'p-1',
        locationId: null,
        physicalCondition: 'GOOD',
        operationalState: 'IN_TRANSIT',
        transferId: 't-1',
        transitDirection: 'DISPATCH',
        quantityDelta: 5,
      });
      expect(transit).not.toBe(movementKey(base.movements[0]));
      expect(transit).toContain('t-1');
    });
  });

  it('canonical payload carries every field that changes meaning', () => {
    const payload = canonicalCommandPayload(base);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'auditStoreId',
        'intents',
        'movements',
        'organizationId',
        'principal',
        'salesOrderId',
        'scopeProductId',
        'transferId',
        'type',
      ].sort(),
    );
  });
});
