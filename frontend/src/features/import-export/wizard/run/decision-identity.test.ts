import { describe, expect, it } from 'vitest';
import { canonicalize, decisionIdentity } from './decision-identity';

/**
 * Whether the decisions changed — the question the wizard used to answer with
 * object identity, and answer wrongly.
 *
 * The effect that retracted a plan was keyed on `[state.mapping,
 * state.acknowledged, relationships]`. React rebuilds those objects on ordinary
 * re-renders, so the effect fired when nothing about the import had changed,
 * and it discarded the plan, the approval and the single-use proof with it.
 */

describe('a re-render is not an edit', () => {
  it('gives an identical answer for a structurally identical rebuild', () => {
    const first = decisionIdentity({
      mapping: { columns: [{ columnIndex: 0, field: 'sku' }], headerRow: 1 },
      acknowledged: [],
      relationships: { stores: { storeIds: ['store-b'] } },
    });
    // A fresh object graph with the same contents — what React hands back after
    // any state update elsewhere in the tree.
    const second = decisionIdentity({
      mapping: { columns: [{ columnIndex: 0, field: 'sku' }], headerRow: 1 },
      acknowledged: [],
      relationships: { stores: { storeIds: ['store-b'] } },
    });

    expect(second).toBe(first);
  });

  it('is unmoved by key order, which describes nothing', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('treats an absent optional field as absent, not as a change', () => {
    // A field that appears as `undefined` while the editor initialises and then
    // disappears is not somebody editing the import.
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe('a real edit is a real change', () => {
  it('notices a field being reassigned', () => {
    const before = decisionIdentity({
      mapping: { columns: [{ columnIndex: 0, field: 'sku' }] },
      acknowledged: [],
      relationships: {},
    });
    const after = decisionIdentity({
      mapping: { columns: [{ columnIndex: 0, field: 'name' }] },
      acknowledged: [],
      relationships: {},
    });
    expect(after).not.toBe(before);
  });

  it('notices a relationship decision changing', () => {
    const before = decisionIdentity({
      mapping: {},
      acknowledged: [],
      relationships: { categories: { columnIndex: 6, createMissing: false } },
    });
    const after = decisionIdentity({
      mapping: {},
      acknowledged: [],
      relationships: { categories: { columnIndex: 6, createMissing: true } },
    });
    expect(after).not.toBe(before);
  });

  it('notices a finding being acknowledged', () => {
    const before = decisionIdentity({ mapping: {}, acknowledged: [], relationships: {} });
    const after = decisionIdentity({ mapping: {}, acknowledged: ['DUPLICATE_SKU'], relationships: {} });
    expect(after).not.toBe(before);
  });

  it('keeps array order significant, because a mapping is positional', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});
