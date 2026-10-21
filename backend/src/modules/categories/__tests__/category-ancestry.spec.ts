import { CategoryNode, compareSiblings, resolveAncestors } from '../hierarchy/category-ancestry';
import { MAX_CATEGORY_DEPTH } from '../entities/category.entity';

/**
 * Ancestry and sibling ordering (Phase 4).
 *
 * The public catalogue truncated paths at ONE parent level before this, so a
 * storefront could not render a breadcrumb for anything nested. These are the
 * rules that replaced it, tested as pure functions because that is what the
 * serializer uses — no database, no ORM, no per-level query.
 */
const node = (over: Partial<CategoryNode> & { id: string }): CategoryNode => ({
  parentId: null,
  name: over.id,
  slug: over.id,
  publicLabel: null,
  sortOrder: 0,
  archivedAt: null,
  ...over,
});

const index = (...nodes: CategoryNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe('resolveAncestors', () => {
  it('returns the whole chain root-first, excluding the category itself', () => {
    const map = index(
      node({ id: 'root', name: 'Catálogo' }),
      node({ id: 'mid', name: 'Designers', parentId: 'root', publicLabel: 'Diseñadores' }),
      node({ id: 'leaf', name: 'Eames', parentId: 'mid' }),
    );

    expect(resolveAncestors(map, 'leaf')).toEqual([
      { id: 'root', name: 'Catálogo', slug: 'root', publicLabel: null },
      { id: 'mid', name: 'Designers', slug: 'mid', publicLabel: 'Diseñadores' },
    ]);
  });

  it('resolves depth far beyond the single level the old serializer emitted', () => {
    const nodes: CategoryNode[] = [];
    for (let i = 0; i < 12; i++) {
      nodes.push(node({ id: `n${i}`, parentId: i === 0 ? null : `n${i - 1}` }));
    }
    const chain = resolveAncestors(index(...nodes), 'n11');
    expect(chain).toHaveLength(11);
    expect(chain[0].id).toBe('n0');
    expect(chain[10].id).toBe('n10');
  });

  it('is empty for a root', () => {
    expect(resolveAncestors(index(node({ id: 'root' })), 'root')).toEqual([]);
  });

  it('truncates at an archived immediate parent, matching parentCategory: null', () => {
    const map = index(
      node({ id: 'root' }),
      node({ id: 'gone', parentId: 'root', archivedAt: new Date() }),
      node({ id: 'leaf', parentId: 'gone' }),
    );
    // The existing serializer emits parentCategory: null when the parent is
    // archived; a path that skipped over it would contradict that.
    expect(resolveAncestors(map, 'leaf')).toEqual([]);
  });

  it('truncates ABOVE an archived grandparent, keeping the visible parent', () => {
    const map = index(
      node({ id: 'gone', archivedAt: new Date() }),
      node({ id: 'mid', parentId: 'gone' }),
      node({ id: 'leaf', parentId: 'mid' }),
    );
    expect(resolveAncestors(map, 'leaf').map((a) => a.id)).toEqual(['mid']);
  });

  it('stops where the index stops, so an out-of-scope parent never leaks', () => {
    // A branch-scoped index simply does not contain another branch's rows.
    const map = index(node({ id: 'leaf', parentId: 'other-branch-parent' }));
    expect(resolveAncestors(map, 'leaf')).toEqual([]);
  });

  it('cannot loop forever on a cycle that reached the database', () => {
    const map = index(node({ id: 'a', parentId: 'b' }), node({ id: 'b', parentId: 'a' }));
    expect(resolveAncestors(map, 'a').length).toBeLessThanOrEqual(MAX_CATEGORY_DEPTH);
  });

  it('is bounded by MAX_CATEGORY_DEPTH on an over-deep chain', () => {
    const nodes: CategoryNode[] = [];
    const total = MAX_CATEGORY_DEPTH + 25;
    for (let i = 0; i < total; i++) {
      nodes.push(node({ id: `d${i}`, parentId: i === 0 ? null : `d${i - 1}` }));
    }
    expect(resolveAncestors(index(...nodes), `d${total - 1}`).length).toBe(MAX_CATEGORY_DEPTH);
  });
});

describe('compareSiblings', () => {
  const sorted = (nodes: CategoryNode[]) => [...nodes].sort(compareSiblings).map((n) => n.id);

  it('orders by sortOrder first', () => {
    expect(
      sorted([node({ id: 'c', sortOrder: 30 }), node({ id: 'a', sortOrder: 10 }), node({ id: 'b', sortOrder: 20 })]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('falls back to name when sortOrder ties', () => {
    expect(
      sorted([node({ id: 'z', name: 'Zebra', sortOrder: 5 }), node({ id: 'a', name: 'Alpha', sortOrder: 5 })]),
    ).toEqual(['a', 'z']);
  });

  it('falls back to id when sortOrder AND name tie, so equal ranks are still stable', () => {
    const first = node({ id: 'aaa', name: 'Same', sortOrder: 1 });
    const second = node({ id: 'bbb', name: 'Same', sortOrder: 1 });
    expect(sorted([second, first])).toEqual(['aaa', 'bbb']);
    // Same input in the other order must produce the same output: that is what
    // "deterministic" has to mean for a paginated public endpoint.
    expect(sorted([first, second])).toEqual(['aaa', 'bbb']);
  });

  it('orders roots by exactly the same rule as any other sibling set', () => {
    const roots = [
      node({ id: 'r2', name: 'B', sortOrder: 0 }),
      node({ id: 'r1', name: 'A', sortOrder: 0 }),
      node({ id: 'r0', name: 'C', sortOrder: -0 }),
    ];
    expect(sorted(roots)).toEqual(['r1', 'r2', 'r0']);
  });
});
