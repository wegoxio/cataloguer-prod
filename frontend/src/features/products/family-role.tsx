import React from 'react';
import Badge from '../../components/ui/badge';
import type { Product } from './types/product.types';

export type FamilyRole = 'PARENT' | 'CHILD' | 'STANDALONE';

/**
 * What an item IS in the parent/child model.
 *
 * Every item has exactly one of three roles, and the interface must SAY which
 * — not leave it to be inferred from a filter, a paragraph, or the absence of a
 * badge. A standalone item was previously the unlabelled default: the only way
 * to know was that nothing else was shown, which is not something a reader can
 * check.
 *
 * Terminology is Parent, Child and Standalone. "Model" and "variant model" are
 * retired (ADR 018) and must not return to anything a person reads.
 */
export function familyRoleOf(product: Pick<Product, 'parent' | 'children'>): FamilyRole {
  if (product.children && product.children.length > 0) return 'PARENT';
  const parentId = typeof product.parent === 'string' ? product.parent : product.parent?.id;
  return parentId ? 'CHILD' : 'STANDALONE';
}

/** The one label for each role, so the list and the detail page cannot drift. */
export function familyRoleLabel(role: FamilyRole, t: (key: string) => string): string {
  if (role === 'PARENT') return t('Parent');
  if (role === 'CHILD') return t('Child');
  return t('Standalone');
}

/**
 * The role as the Items table shows it: plain text in its own column.
 *
 * A parent carries its child count, because "Parent (2)" answers the next
 * question a reader has without opening the item.
 */
export function familyRoleLabelFor(
  product: Pick<Product, 'parent' | 'children'>,
  t: (key: string) => string,
): string {
  const role = familyRoleOf(product);
  const label = familyRoleLabel(role, t);
  return role === 'PARENT' ? `${label} (${product.children?.length ?? 0})` : label;
}

const VARIANT: Record<FamilyRole, 'info' | 'purple' | 'neutral'> = {
  PARENT: 'info',
  CHILD: 'purple',
  STANDALONE: 'neutral',
};

/**
 * The role, stated in words.
 *
 * Colour is decoration here and never the message: each badge carries its own
 * text, so the role survives greyscale, a colour-blind reader and a screen
 * reader alike. `role="status"` is deliberately NOT used — this is a static
 * label, not a live region.
 */
export function FamilyRoleBadge({
  product,
  t,
  className,
}: {
  product: Pick<Product, 'id' | 'parent' | 'children'>;
  t: (key: string) => string;
  className?: string;
}) {
  const role = familyRoleOf(product);
  const label = familyRoleLabel(role, t);
  const count = role === 'PARENT' ? (product.children?.length ?? 0) : 0;
  return (
    <Badge variant={VARIANT[role]} className={className}>
      <span data-testid={`family-role-${product.id}`} data-role={role}>
        {role === 'PARENT' ? `${label} (${count})` : label}
      </span>
    </Badge>
  );
}
