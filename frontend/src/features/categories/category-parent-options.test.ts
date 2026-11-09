import { describe, expect, it } from 'vitest';
import { availableCategoryParents } from './category-parent-options';
import type { Category } from './types/category.types';

const category = (id: string, parentId?: string): Category => ({
  id,
  name: id,
  slug: id,
  parentCategory: parentId ? { id: parentId, name: parentId } : null,
});

describe('availableCategoryParents', () => {
  const categories = [
    category('root-a'),
    category('child-a', 'root-a'),
    category('grandchild-a', 'child-a'),
    category('root-b'),
  ];

  it('offers the complete active directory when creating a category', () => {
    expect(availableCategoryParents(categories).map(({ id }) => id)).toEqual([
      'root-a',
      'child-a',
      'grandchild-a',
      'root-b',
    ]);
  });

  it('excludes the edited category and every descendant while retaining unrelated categories', () => {
    expect(availableCategoryParents(categories, 'root-a').map(({ id }) => id)).toEqual(['root-b']);
  });

  it('still permits ancestors and siblings when editing a child', () => {
    expect(availableCategoryParents(categories, 'child-a').map(({ id }) => id)).toEqual(['root-a', 'root-b']);
  });
});
