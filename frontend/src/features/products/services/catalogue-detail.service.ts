import { apiFetch } from '../../../lib/api-client';

/**
 * The product-detail surfaces Phase 5 makes usable (P5-W4): specifications,
 * documents and related products.
 *
 * One module, because these three panels are the same kind of thing — a
 * bounded read plus a small write against one product — and because keeping
 * raw paths out of components is what stopped the panel drifting from the API
 * everywhere else.
 *
 * NOTHING HERE DECIDES AUTHORITY. Every call is a request the server will
 * accept or refuse on the resolved TenantScope; the capability predicates in
 * `lib/permissions` only stop the panel offering an action it knows will be
 * refused. Both are needed and neither substitutes for the other.
 */

export type FieldValue = string | boolean | null;

export type FieldType = 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT' | 'DATE' | 'URL';

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  unit: string | null;
  source: 'CURATED' | 'CUSTOM';
  /** Presentation group; null means "ungrouped". */
  group: string | null;
  applicability: 'PARENT' | 'CHILD' | 'BOTH';
  childOverrideAllowed: boolean;
  options: string[] | null;
  sortOrder: number;
  archivedAt?: string | null;
}

export interface EffectiveFieldValue {
  definitionId: string;
  key: string;
  label: string;
  group: string | null;
  type: string;
  unit: string | null;
  value: FieldValue;
  /** DIRECT = this product answered; INHERITED = the parent product did. */
  source: 'DIRECT' | 'INHERITED';
  sourceProductId: string;
}

export const RELATION_TYPES = ['RELATED', 'ACCESSORY', 'SIMILAR', 'REPLACEMENT'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface RelatedProduct {
  id: string;
  targetProductId: string;
  targetName: string | null;
  targetSlug: string | null;
  type: RelationType;
  sortOrder: number;
}

const unwrap = <T>(response: any, fallback: T): T => response?.data ?? fallback;

export const catalogueDetailService = {
  /** Every live field definition of the company, groups included. */
  async listFieldDefinitions(token: string): Promise<FieldDefinition[]> {
    const response = await apiFetch('/product-fields', { method: 'GET', token });
    return unwrap<FieldDefinition[]>(response, []);
  },

  /**
   * The EFFECTIVE answers for one product: its own values completed by the
   * parent product's, each labelled with where it came from. Deliberately a
   * different read from the raw values — a form has to be able to say
   * "inherited from the parent product", not merely show a number.
   */
  async listEffectiveValues(token: string, productId: string): Promise<EffectiveFieldValue[]> {
    const response = await apiFetch(`/products/${productId}/fields/effective`, { method: 'GET', token });
    return unwrap<EffectiveFieldValue[]>(response, []);
  },

  async setFieldValue(token: string, productId: string, definitionId: string, value: FieldValue): Promise<void> {
    await apiFetch(`/products/${productId}/fields/${definitionId}`, {
      method: 'PUT',
      token,
      body: JSON.stringify({ value }),
    });
  },

  /** Clears this product's OWN answer. An inherited one may then apply again. */
  async clearFieldValue(token: string, productId: string, definitionId: string): Promise<void> {
    await apiFetch(`/products/${productId}/fields/${definitionId}`, { method: 'DELETE', token });
  },

  async listRelations(token: string, productId: string): Promise<RelatedProduct[]> {
    const response = await apiFetch(`/products/${productId}/relations`, { method: 'GET', token });
    return unwrap<RelatedProduct[]>(response, []);
  },

  async createRelation(
    token: string,
    productId: string,
    body: { targetProductId: string; type: RelationType; sortOrder?: number; reciprocal?: boolean },
  ): Promise<void> {
    await apiFetch(`/products/${productId}/relations`, { method: 'POST', token, body: JSON.stringify(body) });
  },

  async updateRelation(
    token: string,
    productId: string,
    relationId: string,
    body: { sortOrder?: number; type?: RelationType },
  ): Promise<void> {
    await apiFetch(`/products/${productId}/relations/${relationId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    });
  },

  async removeRelation(token: string, productId: string, relationId: string): Promise<void> {
    await apiFetch(`/products/${productId}/relations/${relationId}`, { method: 'DELETE', token });
  },
};
