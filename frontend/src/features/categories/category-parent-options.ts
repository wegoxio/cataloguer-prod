import type { Category } from './types/category.types';

export function availableCategoryParents(categories: Category[], editedCategoryId?: string): Category[] {
  if (!editedCategoryId) return categories;

  const childrenByParent = new Map<string, string[]>();
  for (const category of categories) {
    const parentId = category.parentCategory?.id;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(parentId, children);
  }

  const forbidden = new Set<string>([editedCategoryId]);
  const pending = [...(childrenByParent.get(editedCategoryId) ?? [])];
  while (pending.length > 0) {
    const categoryId = pending.pop()!;
    if (forbidden.has(categoryId)) continue;
    forbidden.add(categoryId);
    pending.push(...(childrenByParent.get(categoryId) ?? []));
  }

  return categories.filter((category) => !forbidden.has(category.id));
}

export function categoryPath(category: Category, categories: Category[]): string {
  const byId = new Map(categories.map((item) => [item.id, item]));
  const path = [category.name];
  const visited = new Set<string>([category.id]);
  let parentId = category.parentCategory?.id;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      const fallback = category.parentCategory?.id === parentId ? category.parentCategory.name : null;
      if (fallback) path.unshift(fallback);
      break;
    }
    path.unshift(parent.name);
    parentId = parent.parentCategory?.id;
  }
  return path.join(' › ');
}
