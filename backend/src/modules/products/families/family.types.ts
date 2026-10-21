/**
 * One child product inside a family, as the management endpoints return it.
 *
 * Owned by the products module (families live on Product.parent); anything
 * rendering or mutating a family imports this instead of re-declaring it.
 */
export interface FamilyMember {
  id: string;
  name: string;
  label: string | null;
}

export interface FamilyMutationResult {
  parentId: string;
  member: FamilyMember;
}

export interface FamilyDissolveResult {
  parentId: string;
  released: number;
}
