import { MAX_CATEGORY_DEPTH } from '../entities/category.entity';

/**
 * The minimum a category must expose to take part in ancestry and ordering.
 * Deliberately not the entity: the public catalogue loads these columns for a
 * whole scope in ONE query and resolves chains in memory, so nothing here may
 * require a populated relation.
 */
export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  publicLabel: string | null;
  sortOrder: number;
  archivedAt: Date | null;
}

/** One step of a public ancestry chain. */
export interface AncestorNode {
  id: string;
  name: string;
  slug: string;
  publicLabel: string | null;
}

/**
 * Order among SIBLINGS — categories sharing a parent, or all roots together.
 *
 * Ties on `sortOrder` fall to `name`, then `id`, so two categories at the same
 * rank still come back in the same order on every request. Comparing across
 * different branches is meaningless and this function is not for that.
 *
 * NOTE: the frontend implements the identical rule in its own layer. The two
 * are not one module — backend and frontend share no runtime package. This
 * side is pinned by unit tests; the frontend has no unit-test framework (only
 * Playwright end-to-end), so its copy is held by typecheck, build and the
 * duplicated documentation, NOT by a test. Changing one means changing both.
 */
export function compareSiblings(a: CategoryNode, b: CategoryNode): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The chain from the root down to the immediate parent, self excluded.
 *
 * ARCHIVED ANCESTORS TRUNCATE. An archived category is not publicly visible,
 * so it can never appear in a path — and neither can anything above it, which
 * would otherwise imply a route through a node the caller cannot see. An
 * archived immediate parent therefore yields `[]`, matching the existing
 * serializer's decision to emit `parentCategory: null` in that case.
 *
 * The walk is bounded by MAX_CATEGORY_DEPTH. A chain longer than that, or a
 * cycle that somehow reached the database, stops rather than hanging — the
 * migration refuses both conditions up front, so neither should exist.
 */
export function resolveAncestors(byId: Map<string, CategoryNode>, categoryId: string): AncestorNode[] {
  const chain: AncestorNode[] = [];
  const seen = new Set<string>([categoryId]);
  let current = byId.get(categoryId);
  let depth = 0;

  while (current?.parentId && depth < MAX_CATEGORY_DEPTH) {
    const parent = byId.get(current.parentId);
    // Missing means out of scope (another branch) or not loaded: the chain
    // ends rather than leaking the existence of something unreadable.
    if (!parent || parent.archivedAt !== null || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push({ id: parent.id, name: parent.name, slug: parent.slug, publicLabel: parent.publicLabel ?? null });
    current = parent;
    depth += 1;
  }

  // Collected parent-upward; a path reads root-first.
  return chain.reverse();
}
