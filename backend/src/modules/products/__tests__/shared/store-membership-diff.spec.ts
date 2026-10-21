import { diffStoreMembership } from '../../shared/store-membership.util';

/**
 * The diff that replaces `Collection.set()` for whole-set membership edits.
 *
 * What these tests are really defending: a branch's commercial state. Price,
 * stock, lead time and publication belong to the branch, and a membership edit
 * naming that branch again must leave them exactly as they were — including a
 * deliberate `published: false`, which must not be quietly reversed.
 */
describe('diffStoreMembership', () => {
  const store = (id: string) => ({ id }) as any;
  const product = { id: 'prod-1' } as any;

  /** A pivot with distinctive commercial state, so any rewrite is visible. */
  const pivot = (storeId: string, over: Record<string, any> = {}) =>
    ({
      id: `pivot-${storeId}`,
      store: store(storeId),
      product,
      organization: 'org-1',
      published: true,
      price: '31.00',
      salePrice: '25.00',
      cost: '12.00',
      stockQuantity: 9,
      trackInventory: true,
      leadTimeDays: 4,
      ...over,
    }) as any;

  const run = (existing: any[], requested: string[]) =>
    diffStoreMembership({
      product,
      organizationId: 'org-1',
      existing,
      requestedStores: requested.map(store),
    });

  it('selects for deletion every pivot whose store is not requested', () => {
    const keep = pivot('store-a');
    const drop = pivot('store-b');

    const diff = run([keep, drop], ['store-a']);

    expect(diff.removed).toEqual([drop]);
    expect(diff.retained).toEqual([keep]);
    expect(diff.created).toEqual([]);
  });

  it('returns a retained pivot as the SAME object, every field untouched', () => {
    const existing = pivot('store-a');
    const before = { ...existing };

    const diff = run([existing], ['store-a']);

    // Identity, not equality: the caller cannot write to a row it never holds
    // a modified copy of.
    expect(diff.retained[0]).toBe(existing);
    expect(diff.retained[0]).toEqual(before);
    expect(diff.created).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('leaves a deliberately unpublished pivot unpublished when its store is named again', () => {
    const hidden = pivot('store-a', { published: false });

    const diff = run([hidden], ['store-a']);

    expect(diff.retained[0]).toBe(hidden);
    expect(diff.retained[0].published).toBe(false);
    // And it is NOT offered for validation, because it is not transitioning.
    expect(diff.publishingStoreIds).toEqual([]);
  });

  it('builds a created pivot carrying every tenant and commercial field it owns', () => {
    const diff = run([], ['store-new']);

    expect(diff.created).toHaveLength(1);
    expect(diff.created[0]).toEqual({
      organization: 'org-1',
      store: store('store-new'),
      product,
      published: true,
      trackInventory: false,
      price: null,
      salePrice: null,
      cost: null,
      leadTimeDays: null,
    });
  });

  it('cannot create duplicate pivots from a repeated store id', () => {
    const diff = run([], ['store-x', 'store-x', 'store-x']);

    expect(diff.created).toHaveLength(1);
    expect(diff.created[0].store.id).toBe('store-x');
    expect(diff.publishingStoreIds).toEqual(['store-x']);
  });

  it('cannot create a pivot for a store that already has one, even if repeated', () => {
    const existing = pivot('store-a');

    const diff = run([existing], ['store-a', 'store-a']);

    expect(diff.created).toEqual([]);
    expect(diff.retained).toEqual([existing]);
  });

  it('produces identical output regardless of input ordering', () => {
    const a = pivot('store-a');
    const b = pivot('store-b');
    const c = pivot('store-c');

    const one = run([a, b, c], ['store-b', 'store-z', 'store-a']);
    const two = run([c, b, a], ['store-a', 'store-b', 'store-z']);

    expect(one.removed.map((r: any) => r.id)).toEqual(two.removed.map((r: any) => r.id));
    expect(one.retained.map((r: any) => r.id)).toEqual(two.retained.map((r: any) => r.id));
    expect(one.created.map((r) => r.store.id)).toEqual(two.created.map((r) => r.store.id));
    expect(one.publishingStoreIds).toEqual(two.publishingStoreIds);
    // and the order is the documented one: by store id
    expect(one.retained.map((r: any) => r.store.id)).toEqual(['store-a', 'store-b']);
    expect(one.removed.map((r: any) => r.store.id)).toEqual(['store-c']);
    expect(one.created.map((r) => r.store.id)).toEqual(['store-z']);
  });

  it('offers required-field validation ONLY the newly publishing stores', () => {
    const retainedPublished = pivot('store-a');
    const retainedHidden = pivot('store-b', { published: false });
    const leaving = pivot('store-c');

    const diff = run([retainedPublished, retainedHidden, leaving], ['store-a', 'store-b', 'store-new']);

    // Not the retained ones — revalidating them could fail a replacement over
    // a store whose publication state it never changed. Not the removed one —
    // it is leaving and cannot violate anything.
    expect(diff.publishingStoreIds).toEqual(['store-new']);
  });

  it('removes every pivot when the requested set is empty', () => {
    const a = pivot('store-a');
    const b = pivot('store-b');

    const diff = run([a, b], []);

    expect(diff.removed.map((r: any) => r.store.id)).toEqual(['store-a', 'store-b']);
    expect(diff.retained).toEqual([]);
    expect(diff.created).toEqual([]);
    expect(diff.publishingStoreIds).toEqual([]);
  });

  it('accepts a pivot whose store is an unloaded reference id', () => {
    // MikroORM may hand back the FK rather than a populated entity; the diff
    // must not mistake that for a different store.
    const unloaded = { ...pivot('store-a'), store: 'store-a' } as any;

    const diff = run([unloaded], ['store-a']);

    expect(diff.retained).toEqual([unloaded]);
    expect(diff.created).toEqual([]);
  });
});
